/**
 * Agent tool: schedule_sequence_touch
 *
 * Autonomous mutation — evaluates a prospect's sequence state, checks the
 * suppression list, appends a CAN-SPAM footer, and dispatches the next email
 * touch via the founder's mailbox router.  Called by the sequence-drip cron
 * on each scheduled interval.
 *
 * Autonomy: autonomous — routes through the cross-boundary bridge because it
 * writes to the DB (mutation class) and dispatches outbound email.
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

// ── DB row shapes ──────────────────────────────────────────────────────────

interface ProspectRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company_name: string | null;
  sequence_status: string | null;
}

interface SequenceRow {
  id: string;
  prospect_id: string;
  campaign_id: string | null;
  touches: unknown;
  current_touch_index: number;
  status: string;
  last_sent_at: string | null;
  next_touch_at: string | null;
}

interface SuppressionRow {
  id: string;
  email: string;
  reason: string;
  suppressed_at: string;
}

interface EmailTouch {
  touch_number: number;
  subject: string;
  body: string;
  personalization_fields: Record<string, string>;
  send_delay_days: number;
}

interface MailboxRouterPayload {
  to: string;
  subject: string;
  body: string;
  prospect_id: string;
  sequence_id: string;
  touch_number: number;
  campaign_id: string | null;
}

interface MailboxRouterResponse {
  message_id: string;
  status: string;
}

// ── CAN-SPAM footer ────────────────────────────────────────────────────────

function appendCanSpamFooter(body: string, prospectId: string, sequenceId: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? "https://localhost:3000";
  const unsubUrl = `${baseUrl}/api/unsubscribe?pid=${encodeURIComponent(prospectId)}&sid=${encodeURIComponent(sequenceId)}`;
  const companyName = process.env.COMPANY_LEGAL_NAME ?? "Our Company";
  const companyAddress = process.env.COMPANY_MAILING_ADDRESS ?? "123 Main Street, Suite 100, San Francisco, CA 94105";

  const footer = [
    "",
    "---",
    `${companyName} · ${companyAddress}`,
    `You are receiving this email because you are a potential business contact.`,
    `To unsubscribe from future emails, click here: ${unsubUrl}`,
  ].join("\n");

  return body + footer;
}

// ── Apply personalization tokens ───────────────────────────────────────────

function applyPersonalization(
  text: string,
  fields: Record<string, string>,
  prospect: ProspectRow
): string {
  const tokens: Record<string, string> = {
    first_name: prospect.first_name ?? "there",
    last_name: prospect.last_name ?? "",
    company_name: prospect.company_name ?? "your company",
    ...fields,
  };

  return Object.entries(tokens).reduce((acc, [key, val]) => {
    return acc.replaceAll(`{{${key}}}`, val);
  }, text);
}

// ── Dispatch via mailbox router ────────────────────────────────────────────

async function dispatchViaMailboxRouter(
  payload: MailboxRouterPayload
): Promise<MailboxRouterResponse> {
  const routerUrl = process.env.MAILBOX_ROUTER_URL;
  if (!routerUrl) {
    throw new Error("MAILBOX_ROUTER_URL environment variable is not set");
  }

  const routerSecret = process.env.MAILBOX_ROUTER_SECRET;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (routerSecret) {
    headers["X-Router-Secret"] = routerSecret;
  }

  const response = await fetch(routerUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Mailbox router error ${response.status}: ${text}`);
  }

  return response.json() as Promise<MailboxRouterResponse>;
}

// ── Main handler ──────────────────────────────────────────────────────────

export async function handleScheduleSequenceTouch(
  ctx: HandlerContext,
  args: Args
): Promise<HandlerResult> {
  const prospectId = args.prospect_id as string | undefined;
  if (!prospectId || typeof prospectId !== "string") {
    return { status: 400, body: "Missing required argument: prospect_id (UUID string)" };
  }

  const sequenceId = args.sequence_id as string | undefined;

  // ── Step 1: Load prospect ─────────────────────────────────────────────
  const prospects = await ctx.db.query<ProspectRow>(
    `SELECT id, first_name, last_name, email, company_name, sequence_status
     FROM sdr_prospects
     WHERE id = $1`,
    prospectId
  );

  if (prospects.length === 0) {
    return { status: 404, body: `Prospect ${prospectId} not found` };
  }

  const prospect = prospects[0];

  if (!prospect.email) {
    return { status: 422, body: `Prospect ${prospectId} has no email address` };
  }

  // ── Step 2: Check suppression list ────────────────────────────────────
  const suppressed = await ctx.db.query<SuppressionRow>(
    `SELECT id, email, reason, suppressed_at
     FROM sdr_suppression_list
     WHERE email = $1
     LIMIT 1`,
    prospect.email
  );

  if (suppressed.length > 0) {
    const entry = suppressed[0];
    await ctx.db.execute(
      `UPDATE sdr_prospects
       SET sequence_status = 'suppressed', updated_at = NOW()
       WHERE id = $1`,
      prospectId
    );
    return {
      status: 200,
      body: {
        skipped: true,
        reason: "suppressed",
        suppression_reason: entry.reason,
        suppressed_at: entry.suppressed_at,
        prospect_id: prospectId,
      },
    };
  }

  // ── Step 3: Load active sequence ──────────────────────────────────────
  const seqQuery = sequenceId
    ? `SELECT id, prospect_id, campaign_id, touches, current_touch_index, status, last_sent_at, next_touch_at
       FROM sdr_email_sequences
       WHERE id = $1 AND prospect_id = $2`
    : `SELECT id, prospect_id, campaign_id, touches, current_touch_index, status, last_sent_at, next_touch_at
       FROM sdr_email_sequences
       WHERE prospect_id = $1 AND status IN ('draft', 'active')
       ORDER BY generated_at DESC
       LIMIT 1`;

  const sequences = sequenceId
    ? await ctx.db.query<SequenceRow>(seqQuery, sequenceId, prospectId)
    : await ctx.db.query<SequenceRow>(seqQuery, prospectId);

  if (sequences.length === 0) {
    return { status: 404, body: `No active sequence found for prospect ${prospectId}` };
  }

  const sequence = sequences[0];

  if (sequence.status === "completed") {
    return {
      status: 200,
      body: { skipped: true, reason: "sequence_completed", prospect_id: prospectId },
    };
  }

  if (sequence.status === "paused") {
    return {
      status: 200,
      body: { skipped: true, reason: "sequence_paused", prospect_id: prospectId },
    };
  }

  // ── Step 4: Determine the next touch ─────────────────────────────────
  const touches = sequence.touches as EmailTouch[];
  if (!Array.isArray(touches) || touches.length === 0) {
    return { status: 422, body: `Sequence ${sequence.id} has no touches` };
  }

  const touchIndex = sequence.current_touch_index ?? 0;
  if (touchIndex >= touches.length) {
    await ctx.db.execute(
      `UPDATE sdr_email_sequences SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      sequence.id
    );
    await ctx.db.execute(
      `UPDATE sdr_prospects SET sequence_status = 'completed', updated_at = NOW() WHERE id = $1`,
      prospectId
    );
    return {
      status: 200,
      body: { skipped: true, reason: "all_touches_sent", prospect_id: prospectId },
    };
  }

  const touch = touches[touchIndex] as EmailTouch;

  // ── Step 5: Build and personalize email ───────────────────────────────
  const personalFields = touch.personalization_fields ?? {};
  const personalizedSubject = applyPersonalization(touch.subject, personalFields, prospect);
  const personalizedBody = applyPersonalization(touch.body, personalFields, prospect);

  // ── Step 6: Append CAN-SPAM footer ────────────────────────────────────
  const bodyWithFooter = appendCanSpamFooter(personalizedBody, prospectId, sequence.id);

  // ── Step 7: Dispatch via mailbox router ───────────────────────────────
  const payload: MailboxRouterPayload = {
    to: prospect.email,
    subject: personalizedSubject,
    body: bodyWithFooter,
    prospect_id: prospectId,
    sequence_id: sequence.id,
    touch_number: touch.touch_number,
    campaign_id: sequence.campaign_id,
  };

  let routerResult: MailboxRouterResponse;
  try {
    routerResult = await dispatchViaMailboxRouter(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 502, body: `Mailbox router dispatch failed: ${message}` };
  }

  // ── Step 8: Update sequence state in DB ──────────────────────────────
  const nextTouchIndex = touchIndex + 1;
  const isLastTouch = nextTouchIndex >= touches.length;
  const nextTouchDelayDays =
    !isLastTouch && touches[nextTouchIndex]
      ? (touches[nextTouchIndex] as EmailTouch).send_delay_days
      : null;

  const nextTouchAt =
    nextTouchDelayDays != null
      ? new Date(Date.now() + nextTouchDelayDays * 86400_000).toISOString()
      : null;

  await ctx.db.execute(
    `UPDATE sdr_email_sequences
     SET current_touch_index = $1,
         status              = $2,
         last_sent_at        = NOW(),
         next_touch_at       = $3,
         updated_at          = NOW()
     WHERE id = $4`,
    nextTouchIndex,
    isLastTouch ? "completed" : "active",
    nextTouchAt,
    sequence.id
  );

  // Record sent touch in audit log
  await ctx.db.execute(
    `INSERT INTO sdr_sequence_touch_log (
       id, sequence_id, prospect_id, touch_number,
       message_id, sent_at
     ) VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT DO NOTHING`,
    crypto.randomUUID(),
    sequence.id,
    prospectId,
    touch.touch_number,
    routerResult.message_id
  );

  if (isLastTouch) {
    await ctx.db.execute(
      `UPDATE sdr_prospects SET sequence_status = 'completed', updated_at = NOW() WHERE id = $1`,
      prospectId
    );
  } else {
    await ctx.db.execute(
      `UPDATE sdr_prospects SET sequence_status = 'active', updated_at = NOW() WHERE id = $1`,
      prospectId
    );
  }

  return {
    status: 200,
    body: {
      dispatched: true,
      sequence_id: sequence.id,
      prospect_id: prospectId,
      touch_number: touch.touch_number,
      touch_index: touchIndex,
      message_id: routerResult.message_id,
      email_to: prospect.email,
      subject: personalizedSubject,
      is_last_touch: isLastTouch,
      next_touch_at: nextTouchAt,
      sequence_status: isLastTouch ? "completed" : "active",
    },
  };
}
