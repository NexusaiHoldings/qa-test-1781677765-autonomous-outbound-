/**
 * POST /api/webhooks/gmail
 *
 * Receives Google Cloud Pub/Sub push notifications for Gmail watch events.
 * When a new message arrives in a watched mailbox, Google sends:
 *
 *   POST /api/webhooks/gmail?token=<GMAIL_WEBHOOK_TOKEN>
 *   {
 *     "message": { "data": "<base64url-encoded JSON>", "messageId": "...", "publishTime": "..." },
 *     "subscription": "projects/.../subscriptions/..."
 *   }
 *
 * The base64-decoded data contains: { "emailAddress": "user@example.com", "historyId": 12345 }
 *
 * Flow:
 *   1. Verify the shared secret token in the query string.
 *   2. Decode the Pub/Sub message to get emailAddress + historyId.
 *   3. Look up the stored OAuth refresh token for that mailbox.
 *   4. Fetch Gmail history since the last known historyId to find new messages.
 *   5. For each new message that is a reply (has In-Reply-To header):
 *      a. Extract headers + body text.
 *      b. Classify with GPT.
 *      c. Persist to sdr_replies.
 *      d. If unsubscribe → add to sdr_suppression.
 *      e. If genuine_interest → mark sequence as paused.
 *   6. Return 200 (Google retries on non-2xx).
 */

import { NextResponse } from "next/server";
import { buildDb } from "@/lib/db";
import { classifyReply } from "@/lib/sdr/reply-classifier";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface DbClient {
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  execute(sql: string, ...params: unknown[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Table bootstrap (idempotent — runs on first webhook hit)
// ---------------------------------------------------------------------------

async function ensureSdrTables(db: DbClient): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sdr_mail_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      email TEXT NOT NULL,
      provider TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      last_history_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(email, provider)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS sdr_replies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source TEXT NOT NULL,
      message_id TEXT NOT NULL,
      thread_id TEXT,
      from_email TEXT NOT NULL,
      from_name TEXT,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL,
      category TEXT NOT NULL,
      confidence FLOAT NOT NULL DEFAULT 0,
      summary TEXT,
      coaching_context TEXT,
      sequence_paused BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(source, message_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS sdr_suppression (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      source_reply_id UUID,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ---------------------------------------------------------------------------
// Gmail API helpers
// ---------------------------------------------------------------------------

async function getGmailAccessToken(
  emailAddress: string,
  db: DbClient,
): Promise<{ accessToken: string; lastHistoryId: string | null } | null> {
  const rows = await db.query<{ refresh_token: string; last_history_id: string | null }>(
    `SELECT refresh_token, last_history_id FROM sdr_mail_accounts WHERE email = $1 AND provider = 'gmail' LIMIT 1`,
    emailAddress,
  );
  if (!rows.length) return null;

  const { refresh_token: refreshToken, last_history_id: lastHistoryId } = rows[0];

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error(`[gmail-webhook] token refresh failed (${resp.status}): ${detail.slice(0, 200)}`);
    return null;
  }

  const tokenData = (await resp.json()) as { access_token?: string };
  if (!tokenData.access_token) return null;

  return { accessToken: tokenData.access_token, lastHistoryId };
}

interface GmailMessage {
  id: string;
  threadId: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    parts?: Array<{ mimeType: string; body?: { data?: string } }>;
    body?: { data?: string };
    mimeType?: string;
  };
  internalDate?: string;
}

function getHeader(msg: GmailMessage, name: string): string {
  return (
    msg.payload?.headers?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase(),
    )?.value ?? ""
  );
}

function extractTextBody(msg: GmailMessage): string {
  const payload = msg.payload;
  if (!payload) return "";

  // Multipart message — look for text/plain part
  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) {
      return Buffer.from(plain.body.data, "base64url").toString("utf-8");
    }
    // Fall back to text/html
    const html = payload.parts.find((p) => p.mimeType === "text/html");
    if (html?.body?.data) {
      return Buffer.from(html.body.data, "base64url")
        .toString("utf-8")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  // Simple single-part
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  return "";
}

async function fetchGmailHistory(
  accessToken: string,
  startHistoryId: string,
): Promise<Array<{ messageId: string }>> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
  url.searchParams.set("startHistoryId", startHistoryId);
  url.searchParams.set("historyTypes", "messageAdded");
  url.searchParams.set("labelId", "INBOX");

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error(`[gmail-webhook] history fetch failed (${resp.status}): ${detail.slice(0, 200)}`);
    return [];
  }

  const data = (await resp.json()) as {
    history?: Array<{
      messagesAdded?: Array<{ message: { id: string } }>;
    }>;
  };

  const messageIds: Array<{ messageId: string }> = [];
  for (const h of data.history ?? []) {
    for (const added of h.messagesAdded ?? []) {
      messageIds.push({ messageId: added.message.id });
    }
  }
  return messageIds;
}

async function fetchGmailMessage(
  accessToken: string,
  messageId: string,
): Promise<GmailMessage | null> {
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) return null;
  return (await resp.json()) as GmailMessage;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  // Verify shared webhook token to ensure the request is from our Pub/Sub subscription
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const expectedToken = process.env.GMAIL_WEBHOOK_TOKEN;
  if (expectedToken && token !== expectedToken) {
    console.warn("[gmail-webhook] invalid or missing token");
    return new NextResponse("Unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  const pubsubMsg = body as {
    message?: { data?: string; messageId?: string };
    subscription?: string;
  };

  if (!pubsubMsg.message?.data) {
    // Return 200 so Google doesn't retry (may be a keepalive)
    return new NextResponse("OK", { status: 200 });
  }

  let notification: { emailAddress?: string; historyId?: number | string };
  try {
    const decoded = Buffer.from(pubsubMsg.message.data, "base64url").toString("utf-8");
    notification = JSON.parse(decoded) as typeof notification;
  } catch {
    console.error("[gmail-webhook] failed to decode Pub/Sub message");
    return new NextResponse("OK", { status: 200 });
  }

  const emailAddress = notification.emailAddress;
  const historyId = String(notification.historyId ?? "");

  if (!emailAddress || !historyId) {
    return new NextResponse("OK", { status: 200 });
  }

  console.log(`[gmail-webhook] notification for ${emailAddress}, historyId=${historyId}`);

  const db = buildDb() as DbClient;
  try {
    await ensureSdrTables(db);
  } catch (err) {
    console.error("[gmail-webhook] table bootstrap error:", err);
    return new NextResponse("OK", { status: 200 });
  }

  const tokenResult = await getGmailAccessToken(emailAddress, db);
  if (!tokenResult) {
    console.warn(`[gmail-webhook] no stored credentials for ${emailAddress}`);
    return new NextResponse("OK", { status: 200 });
  }

  const { accessToken, lastHistoryId } = tokenResult;
  const startHistoryId = lastHistoryId ?? historyId;

  const addedMessages = await fetchGmailHistory(accessToken, startHistoryId);

  for (const { messageId } of addedMessages) {
    const msg = await fetchGmailMessage(accessToken, messageId);
    if (!msg) continue;

    // Only process replies (must have In-Reply-To header)
    const inReplyTo = getHeader(msg, "In-Reply-To");
    if (!inReplyTo) continue;

    const from = getHeader(msg, "From");
    const subject = getHeader(msg, "Subject");
    const toHeader = getHeader(msg, "To");
    const bodyText = extractTextBody(msg);

    if (!from || !bodyText) continue;

    // Parse "Name <email>" format
    const fromMatch = from.match(/^(.*?)\s*<([^>]+)>$/) ?? [];
    const fromName = fromMatch[1]?.trim() || undefined;
    const fromEmail = fromMatch[2]?.trim() ?? from.trim();

    const receivedAt = msg.internalDate
      ? new Date(parseInt(msg.internalDate, 10)).toISOString()
      : new Date().toISOString();

    let classification;
    try {
      classification = await classifyReply({
        subject,
        body: bodyText,
        from_email: fromEmail,
        from_name: fromName,
      });
    } catch (err) {
      console.error(`[gmail-webhook] classification error for ${messageId}:`, err);
      continue;
    }

    try {
      await db.execute(
        `INSERT INTO sdr_replies
           (source, message_id, thread_id, from_email, from_name, to_email,
            subject, body_text, received_at, category, confidence, summary,
            coaching_context, sequence_paused)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (source, message_id) DO NOTHING`,
        "gmail",
        msg.id,
        msg.threadId ?? null,
        fromEmail,
        fromName ?? null,
        toHeader || emailAddress,
        subject,
        bodyText,
        receivedAt,
        classification.category,
        classification.confidence,
        classification.summary,
        classification.coaching_context,
        classification.category === "genuine_interest",
      );

      if (classification.category === "unsubscribe") {
        await db.execute(
          `INSERT INTO sdr_suppression (email, reason, source_reply_id)
           SELECT $1, $2, id FROM sdr_replies
           WHERE source = 'gmail' AND message_id = $3
           ON CONFLICT (email) DO NOTHING`,
          fromEmail,
          "Replied with unsubscribe request",
          msg.id,
        );
        console.log(`[gmail-webhook] added ${fromEmail} to suppression list`);
      }

      console.log(
        `[gmail-webhook] stored reply ${msg.id} category=${classification.category} confidence=${classification.confidence.toFixed(2)}`,
      );
    } catch (err) {
      console.error(`[gmail-webhook] DB error for message ${messageId}:`, err);
    }
  }

  // Update last seen historyId for this account
  try {
    await db.execute(
      `UPDATE sdr_mail_accounts SET last_history_id = $1, updated_at = NOW()
       WHERE email = $2 AND provider = 'gmail'`,
      historyId,
      emailAddress,
    );
  } catch (err) {
    console.error("[gmail-webhook] failed to update historyId:", err);
  }

  return new NextResponse("OK", { status: 200 });
}
