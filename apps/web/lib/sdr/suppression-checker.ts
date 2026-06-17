import { buildDb } from "@/lib/db";

export type SuppressionReason =
  | "unsubscribed"
  | "bounced"
  | "replied"
  | "paused"
  | "complained";

export interface SuppressionResult {
  suppressed: boolean;
  reason?: SuppressionReason;
}

/**
 * Checks whether an email address appears on the global suppression list
 * (unsubscribed, hard bounced, or spam complaint). The check is
 * case-insensitive and honours optional TTL via expires_at.
 */
export async function isEmailSuppressed(
  email: string
): Promise<SuppressionResult> {
  const db = buildDb();
  const rows = await db.query<{ reason: string }>(
    `SELECT reason
       FROM sdr_suppression_list
      WHERE email = LOWER($1)
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1`,
    email.toLowerCase()
  );
  if (rows.length === 0) return { suppressed: false };
  return { suppressed: true, reason: rows[0].reason as SuppressionReason };
}

/**
 * Checks whether a specific prospect enrollment should be skipped because:
 *   1. A reply event has been detected (auto-pause trigger), or
 *   2. The enrollment has been manually paused.
 *
 * Reply detection takes priority so callers can distinguish the two cases and
 * record the pause_reason accordingly.
 */
export async function isEnrollmentSuppressed(
  enrollmentId: string
): Promise<SuppressionResult> {
  const db = buildDb();

  const replyRows = await db.query<{ id: string }>(
    `SELECT id
       FROM sdr_reply_events
      WHERE enrollment_id = $1
      LIMIT 1`,
    enrollmentId
  );
  if (replyRows.length > 0) return { suppressed: true, reason: "replied" };

  const enrollRows = await db.query<{ status: string }>(
    `SELECT status
       FROM sdr_prospect_enrollments
      WHERE id = $1
      LIMIT 1`,
    enrollmentId
  );
  if (enrollRows.length === 0) return { suppressed: true, reason: "paused" };
  if (enrollRows[0].status === "paused") {
    return { suppressed: true, reason: "paused" };
  }

  return { suppressed: false };
}

/**
 * Combined suppression check: tests the global email suppression list first,
 * then the per-enrollment reply / manual-pause status. Returns on the first
 * match so callers can act on the specific reason without running redundant
 * queries.
 */
export async function checkSuppression(
  email: string,
  enrollmentId: string
): Promise<SuppressionResult> {
  const emailResult = await isEmailSuppressed(email);
  if (emailResult.suppressed) return emailResult;
  return isEnrollmentSuppressed(enrollmentId);
}
