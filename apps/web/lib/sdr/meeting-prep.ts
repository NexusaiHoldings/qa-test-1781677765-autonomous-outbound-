/**
 * Meeting prep summaries for SDR calendar integration (F1-009).
 *
 * Generates briefing content before each booked founder call, persists
 * it to sdr_meetings.prep_summary, and dispatches via the notifications
 * lego 24 h before the meeting.
 */

import type { SdrMeeting } from "./calendar-sync";

export interface MeetingPrepSummary {
  meeting_id: string;
  prospect_name: string;
  prospect_email: string;
  meeting_title: string;
  meeting_start_time: string;
  company_research: string;
  talking_points: string[];
  background_notes: string;
  generated_at: string;
}

export interface ProspectContext {
  name: string;
  email: string;
  company?: string;
  role?: string;
  linkedin_url?: string;
  recent_news?: string[];
  pain_points?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pool: any = null;

function getPool(): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
} {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    };
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

export function generatePrepSummary(
  meeting: SdrMeeting,
  context?: ProspectContext,
): MeetingPrepSummary {
  const companyPart = context?.company ? ` at ${context.company}` : "";
  const rolePart = context?.role ? ` (${context.role})` : "";
  const companyResearch = `Contact: ${meeting.prospect_name}${rolePart}${companyPart} — ${meeting.prospect_email}`;

  const talkingPoints: string[] = [
    `Confirm agenda and goals for "${meeting.meeting_title}"`,
    `Understand ${meeting.prospect_name}'s current workflow and top challenges`,
    `Present 2-3 relevant use cases matching their context`,
    `Explore timeline, budget, and decision-making process`,
    `Agree on concrete next steps before the call ends`,
  ];

  if (context?.pain_points && context.pain_points.length > 0) {
    talkingPoints.push(`Address known pain points: ${context.pain_points.slice(0, 2).join(", ")}`);
  }

  const backgroundNotes = meeting.notes
    ? `Notes from booking: ${meeting.notes}`
    : `Booked via ${meeting.booking_source ?? "direct calendar link"}`;

  return {
    meeting_id: meeting.id,
    prospect_name: meeting.prospect_name,
    prospect_email: meeting.prospect_email,
    meeting_title: meeting.meeting_title,
    meeting_start_time: meeting.meeting_start_time,
    company_research: companyResearch,
    talking_points: talkingPoints,
    background_notes: backgroundNotes,
    generated_at: new Date().toISOString(),
  };
}

export function buildPrepEmailHtml(
  summary: MeetingPrepSummary,
  meetingDate: string,
): string {
  const pointsHtml = summary.talking_points
    .map((p) => `<li style="margin-bottom:6px;">${p}</li>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;color:#111;max-width:600px;margin:0 auto;padding:24px}
    h1{font-size:20px;font-weight:600;margin:0 0 4px}
    h2{font-size:15px;font-weight:600;margin:20px 0 8px}
    .meta{color:#555;font-size:13px;margin:0 0 20px}
    .card{background:#f7f7f7;border:1px solid #e4e4e4;border-radius:8px;padding:16px;margin:16px 0}
    ul{padding-left:20px;margin:0}
    li{font-size:14px}
    .footer{color:#888;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:16px}
  </style>
</head>
<body>
  <h1>Meeting Prep: ${summary.meeting_title}</h1>
  <p class="meta">Scheduled for ${meetingDate}</p>

  <div class="card">
    <h2>About Your Contact</h2>
    <p style="margin:0 0 8px;font-size:14px">${summary.company_research}</p>
    <p style="margin:0;font-size:13px;color:#555">${summary.background_notes}</p>
  </div>

  <h2>Suggested Talking Points</h2>
  <ul>${pointsHtml}</ul>

  <p class="footer">
    This prep summary was automatically generated 24 hours before your call.
    Adjust talking points based on the specific context of your conversation.
  </p>
</body>
</html>`;
}

export async function savePrepSummary(
  meetingId: string,
  summary: MeetingPrepSummary,
): Promise<void> {
  await getPool().query(
    "UPDATE sdr_meetings SET prep_summary = $1, updated_at = now() WHERE id = $2",
    [JSON.stringify(summary), meetingId],
  );
}

export async function sendPrepEmail(
  founderId: string,
  founderEmail: string,
  summary: MeetingPrepSummary,
): Promise<void> {
  const meetingDate = new Date(summary.meeting_start_time).toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const html = buildPrepEmailHtml(summary, meetingDate);
  const baseUrl = process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";

  const res = await fetch(`${baseUrl}/api/notifications/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: founderEmail,
      subject: `Meeting Prep: ${summary.meeting_title} — ${meetingDate}`,
      html,
      channel: "email",
      user_id: founderId,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to send prep email (${res.status}): ${errText}`);
  }

  await getPool().query(
    "UPDATE sdr_meetings SET prep_sent_at = now(), updated_at = now() WHERE id = $1",
    [summary.meeting_id],
  );
}

export async function processUpcomingMeetingPrep(
  founderId: string,
  founderEmail: string,
  hoursAhead = 24,
): Promise<number> {
  const cutoff = new Date(Date.now() + hoursAhead * 3_600_000).toISOString();
  let sent = 0;

  try {
    const { rows } = await getPool().query(
      `SELECT * FROM sdr_meetings
        WHERE founder_id = $1
          AND status = 'scheduled'
          AND prep_sent_at IS NULL
          AND meeting_start_time > now()
          AND meeting_start_time <= $2
        ORDER BY meeting_start_time ASC`,
      [founderId, cutoff],
    );

    for (const row of rows as SdrMeeting[]) {
      const summary = generatePrepSummary(row);
      await savePrepSummary(row.id, summary);
      await sendPrepEmail(founderId, founderEmail, summary);
      sent++;
    }
  } catch {
    // Log silently — cron handlers must not throw
  }

  return sent;
}
