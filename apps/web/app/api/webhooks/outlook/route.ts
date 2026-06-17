/**
 * GET  /api/webhooks/outlook  — subscription validation handshake
 * POST /api/webhooks/outlook  — Microsoft Graph change notifications
 *
 * Microsoft Graph sends a GET with ?validationToken=… when creating a
 * subscription; respond with the token as plain text (200) to confirm.
 *
 * Subsequent change notifications arrive as POST:
 *   {
 *     "value": [
 *       {
 *         "changeType": "created",
 *         "resource": "Users/<userId>/Messages/<messageId>",
 *         "resourceData": { "@odata.id": "...", "id": "<messageId>" },
 *         "clientState": "<OUTLOOK_WEBHOOK_TOKEN>"
 *       }
 *     ]
 *   }
 *
 * Flow:
 *   1. Verify clientState matches OUTLOOK_WEBHOOK_TOKEN.
 *   2. For each notification item fetch the full message from Microsoft Graph.
 *   3. Skip messages that are not replies (no In-Reply-To header).
 *   4. Classify with GPT.
 *   5. Persist to sdr_replies.
 *   6. If unsubscribe → add to sdr_suppression.
 *   7. Return 202 Accepted (Graph retries on non-2xx).
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
// Table bootstrap (same schema as Gmail handler — idempotent)
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
// Microsoft Graph helpers
// ---------------------------------------------------------------------------

interface GraphTokenRow {
  refresh_token: string;
  email: string;
}

async function getGraphAccessToken(
  userId: string,
  db: DbClient,
): Promise<{ accessToken: string; email: string } | null> {
  const rows = await db.query<GraphTokenRow>(
    `SELECT refresh_token, email FROM sdr_mail_accounts WHERE user_id = $1 AND provider = 'outlook' LIMIT 1`,
    userId,
  );
  if (!rows.length) return null;

  const { refresh_token: refreshToken, email } = rows[0];

  const tenantId = process.env.MICROSOFT_TENANT_ID ?? "common";
  const resp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID ?? "",
        client_secret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope: "https://graph.microsoft.com/Mail.Read offline_access",
      }),
    },
  );

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error(
      `[outlook-webhook] token refresh failed (${resp.status}): ${detail.slice(0, 200)}`,
    );
    return null;
  }

  const tokenData = (await resp.json()) as { access_token?: string };
  if (!tokenData.access_token) return null;

  return { accessToken: tokenData.access_token, email };
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  body?: { content?: string; contentType?: string };
  internetMessageHeaders?: Array<{ name: string; value: string }>;
}

async function fetchGraphMessage(
  accessToken: string,
  userId: string,
  messageId: string,
): Promise<GraphMessage | null> {
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}?$select=id,conversationId,subject,receivedDateTime,from,toRecipients,body,internetMessageHeaders`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error(
      `[outlook-webhook] message fetch failed (${resp.status}): ${detail.slice(0, 200)}`,
    );
    return null;
  }

  return (await resp.json()) as GraphMessage;
}

function getInternetHeader(msg: GraphMessage, name: string): string {
  return (
    msg.internetMessageHeaders?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase(),
    )?.value ?? ""
  );
}

function extractGraphBodyText(msg: GraphMessage): string {
  if (!msg.body?.content) return "";
  if (msg.body.contentType === "text") return msg.body.content;
  // Strip HTML tags for text extraction
  return msg.body.content
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract userId from Graph resource path: "Users/<userId>/Messages/<messageId>"
function parseGraphResource(resource: string): {
  userId: string;
  messageId: string;
} | null {
  const match = resource.match(/Users\/([^/]+)\/[Mm]essages\/([^/]+)/);
  if (!match) return null;
  return { userId: match[1], messageId: match[2] };
}

// ---------------------------------------------------------------------------
// GET — subscription validation
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    // Microsoft requires plain-text response with the token verbatim
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new NextResponse("Not found", { status: 404 });
}

// ---------------------------------------------------------------------------
// POST — change notifications
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  // Microsoft validation challenge can also arrive on POST
  const url = new URL(request.url);
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  const payload = body as {
    value?: Array<{
      changeType?: string;
      resource?: string;
      resourceData?: { id?: string };
      clientState?: string;
    }>;
  };

  if (!payload.value?.length) {
    return new NextResponse("", { status: 202 });
  }

  const expectedState = process.env.OUTLOOK_WEBHOOK_TOKEN;

  const db = buildDb() as DbClient;
  try {
    await ensureSdrTables(db);
  } catch (err) {
    console.error("[outlook-webhook] table bootstrap error:", err);
    return new NextResponse("", { status: 202 });
  }

  for (const item of payload.value) {
    // Verify clientState when configured
    if (expectedState && item.clientState !== expectedState) {
      console.warn("[outlook-webhook] clientState mismatch — skipping item");
      continue;
    }

    if (item.changeType !== "created") continue;
    if (!item.resource) continue;

    const parsed = parseGraphResource(item.resource);
    if (!parsed) {
      console.warn(`[outlook-webhook] could not parse resource: ${item.resource}`);
      continue;
    }

    const { userId, messageId } = parsed;

    const tokenResult = await getGraphAccessToken(userId, db);
    if (!tokenResult) {
      console.warn(`[outlook-webhook] no stored credentials for userId=${userId}`);
      continue;
    }

    const { accessToken, email: accountEmail } = tokenResult;
    const msg = await fetchGraphMessage(accessToken, userId, messageId);
    if (!msg) continue;

    // Only process replies
    const inReplyTo = getInternetHeader(msg, "In-Reply-To");
    if (!inReplyTo) continue;

    const fromEmail = msg.from?.emailAddress?.address ?? "";
    const fromName = msg.from?.emailAddress?.name ?? undefined;
    const subject = msg.subject ?? "(no subject)";
    const toEmail =
      msg.toRecipients?.[0]?.emailAddress?.address ?? accountEmail;
    const bodyText = extractGraphBodyText(msg);
    const receivedAt = msg.receivedDateTime ?? new Date().toISOString();

    if (!fromEmail || !bodyText) continue;

    let classification;
    try {
      classification = await classifyReply({
        subject,
        body: bodyText,
        from_email: fromEmail,
        from_name: fromName,
      });
    } catch (err) {
      console.error(`[outlook-webhook] classification error for ${messageId}:`, err);
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
        "outlook",
        msg.id,
        msg.conversationId ?? null,
        fromEmail,
        fromName ?? null,
        toEmail,
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
           WHERE source = 'outlook' AND message_id = $3
           ON CONFLICT (email) DO NOTHING`,
          fromEmail,
          "Replied with unsubscribe request",
          msg.id,
        );
        console.log(`[outlook-webhook] added ${fromEmail} to suppression list`);
      }

      console.log(
        `[outlook-webhook] stored reply ${msg.id} category=${classification.category} confidence=${classification.confidence.toFixed(2)}`,
      );
    } catch (err) {
      console.error(`[outlook-webhook] DB error for message ${messageId}:`, err);
    }
  }

  // Graph requires 202 Accepted to stop retries
  return new NextResponse("", { status: 202 });
}
