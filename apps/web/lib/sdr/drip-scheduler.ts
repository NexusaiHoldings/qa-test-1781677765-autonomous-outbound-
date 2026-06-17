import { buildDb } from "@/lib/db";
import { checkSuppression } from "@/lib/sdr/suppression-checker";
import { generateCanSpamFooter, generateTrackingPixel } from "@/lib/sdr/can-spam-footer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DueTouchRow {
  enrollment_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  campaign_id: string;
  step_id: string;
  step_number: number;
  delay_days: number;
  subject: string;
  body_html: string;
  body_text: string | null;
  from_email: string;
  from_name: string;
  company_name: string;
  company_address: string;
  company_city: string;
  company_state: string;
  company_zip: string;
}

interface ResendSendResult {
  id: string;
}

export interface DripRunResult {
  dispatched: number;
  skipped: number;
  paused: number;
  errors: number;
  details: Array<{
    enrollmentId: string;
    stepNumber: number;
    email: string;
    outcome: "sent" | "skipped" | "paused" | "error";
    error?: string;
  }>;
}

// ---------------------------------------------------------------------------
// DB helpers — stubs replaced in Pass 2
// ---------------------------------------------------------------------------

async function fetchDueTouches(batchSize: number): Promise<DueTouchRow[]> {
  const db = buildDb();
  return db.query<DueTouchRow>(
    `WITH next_due AS (
       SELECT DISTINCT ON (e.id)
         e.id            AS enrollment_id,
         e.email,
         e.first_name,
         e.last_name,
         e.campaign_id,
         s.id            AS step_id,
         s.step_number,
         s.delay_days,
         s.subject,
         s.body_html,
         s.body_text,
         c.from_email,
         c.from_name,
         c.company_name,
         c.company_address,
         c.company_city,
         c.company_state,
         c.company_zip
       FROM sdr_prospect_enrollments e
       JOIN sdr_campaigns            c  ON c.id = e.campaign_id
       JOIN sdr_sequence_steps       s  ON s.campaign_id = e.campaign_id
       WHERE c.status = 'active'
         AND e.status  = 'active'
         AND NOW() >= e.enrolled_at + (s.delay_days || ' days')::INTERVAL
         AND NOT EXISTS (
           SELECT 1 FROM sdr_touch_sends ts
            WHERE ts.enrollment_id = e.id
              AND ts.step_id       = s.id
         )
         AND (
           s.step_number = 1
           OR EXISTS (
             SELECT 1
               FROM sdr_touch_sends    prev_ts
               JOIN sdr_sequence_steps prev_s ON prev_s.id = prev_ts.step_id
              WHERE prev_ts.enrollment_id = e.id
                AND prev_s.step_number   = s.step_number - 1
                AND prev_ts.status       = 'sent'
           )
         )
       ORDER BY e.id, s.step_number
     )
     SELECT * FROM next_due
     ORDER BY enrollment_id
     LIMIT $1`,
    batchSize
  );
}

async function insertTouchSend(
  enrollmentId: string,
  stepId: string,
  messageId: string,
  status: "sent" | "failed"
): Promise<void> {
  const db = buildDb();
  await db.execute(
    `INSERT INTO sdr_touch_sends
       (id, enrollment_id, step_id, message_id, status, sent_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())`,
    enrollmentId,
    stepId,
    messageId,
    status
  );
}

async function pauseEnrollment(
  enrollmentId: string,
  reason: string
): Promise<void> {
  const db = buildDb();
  await db.execute(
    `UPDATE sdr_prospect_enrollments
        SET status       = 'paused',
            paused_at    = NOW(),
            pause_reason = $2
      WHERE id = $1`,
    enrollmentId,
    reason
  );
}

async function markEnrollmentCompleted(enrollmentId: string): Promise<void> {
  const db = buildDb();
  await db.execute(
    `UPDATE sdr_prospect_enrollments
        SET status       = 'completed',
            completed_at = NOW()
      WHERE id = $1`,
    enrollmentId
  );
}

async function countRemainingSteps(
  campaignId: string,
  _enrollmentId: string,
  currentStepNumber: number
): Promise<number> {
  const db = buildDb();
  const rows = await db.query<{ remaining: string }>(
    `SELECT COUNT(*) AS remaining
       FROM sdr_sequence_steps
      WHERE campaign_id  = $1
        AND step_number  > $2`,
    campaignId,
    currentStepNumber
  );
  return parseInt(rows[0]?.remaining ?? "0", 10);
}

// ---------------------------------------------------------------------------
// Email dispatch — stub replaced in Pass 2
// ---------------------------------------------------------------------------

async function sendViaResend(
  to: string,
  fromEmail: string,
  fromName: string,
  subject: string,
  html: string,
  text: string
): Promise<ResendSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [to],
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "unknown");
    throw new Error(`Resend API ${response.status}: ${body.slice(0, 200)}`);
  }

  return (await response.json()) as ResendSendResult;
}

function buildEmailBody(
  touch: DueTouchRow,
  touchSendPlaceholder: string,
  appUrl: string
): { html: string; text: string } {
  const footer = generateCanSpamFooter({
    companyName: touch.company_name,
    street: touch.company_address,
    city: touch.company_city,
    state: touch.company_state,
    zip: touch.company_zip,
    unsubscribeUrl: `${appUrl}/api/unsubscribe?email=${encodeURIComponent(touch.email)}`,
  });

  const pixel = generateTrackingPixel(touchSendPlaceholder, appUrl);
  const html = `${touch.body_html}${pixel}${footer.html}`;
  const text = `${touch.body_text ?? ""}${footer.text}`;
  return { html, text };
}

// ---------------------------------------------------------------------------
// Main entry point — stub replaced in Pass 2
// ---------------------------------------------------------------------------

/**
 * Main entry point for the sequence drip cron job.
 *
 * Fetches up to `batchSize` due touches across all active campaigns, checks
 * suppression (global list + reply detection), dispatches emails via Resend,
 * records outcomes in sdr_touch_sends, and automatically pauses enrollments
 * when a prospect reply is detected.
 */
export async function scheduleDrip(
  batchSize: number = 100
): Promise<DripRunResult> {
  const result: DripRunResult = {
    dispatched: 0,
    skipped: 0,
    paused: 0,
    errors: 0,
    details: [],
  };

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000");

  let dueTouches: DueTouchRow[];
  try {
    dueTouches = await fetchDueTouches(batchSize);
  } catch (err) {
    const msg = String((err as Error).message);
    // Gracefully handle pre-migration state where SDR tables don't yet exist.
    if (msg.includes("does not exist") || msg.includes("relation")) {
      return result;
    }
    throw err;
  }

  for (const touch of dueTouches) {
    const { enrollment_id, email, step_number, step_id, campaign_id } = touch;
    try {
      const suppression = await checkSuppression(email, enrollment_id);

      if (suppression.suppressed) {
        if (suppression.reason === "replied") {
          await pauseEnrollment(enrollment_id, "reply_detected");
          result.paused++;
          result.details.push({ enrollmentId: enrollment_id, stepNumber: step_number, email, outcome: "paused" });
        } else {
          result.skipped++;
          result.details.push({ enrollmentId: enrollment_id, stepNumber: step_number, email, outcome: "skipped" });
        }
        continue;
      }

      const { html, text } = buildEmailBody(touch, enrollment_id, appUrl);

      const sendResult = await sendViaResend(
        email,
        touch.from_email,
        touch.from_name,
        touch.subject,
        html,
        text
      );

      await insertTouchSend(enrollment_id, step_id, sendResult.id, "sent");

      const remaining = await countRemainingSteps(campaign_id, enrollment_id, step_number);
      if (remaining === 0) {
        await markEnrollmentCompleted(enrollment_id);
      }

      result.dispatched++;
      result.details.push({ enrollmentId: enrollment_id, stepNumber: step_number, email, outcome: "sent" });
    } catch (err) {
      const errMsg = String((err as Error).message).slice(0, 500);
      await insertTouchSend(enrollment_id, step_id, "", "failed").catch(() => {});
      result.errors++;
      result.details.push({ enrollmentId: enrollment_id, stepNumber: step_number, email, outcome: "error", error: errMsg });
    }
  }

  return result;
}
