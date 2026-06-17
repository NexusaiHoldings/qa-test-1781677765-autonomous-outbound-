/**
 * Google Calendar sync for SDR meeting booking integration (F1-009).
 *
 * Handles bi-directional Google Calendar API calls, booking confirmations,
 * and meeting persistence. Access tokens come from the founder's OAuth session
 * (managed by @nexus/identity-and-access with Google Calendar scopes).
 */

export interface GoogleCalendarEvent {
  id: string;
  summary: string;
  description?: string | null;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string }>;
  htmlLink?: string | null;
  status?: string | null;
}

export interface FreeBusySlot {
  start: string;
  end: string;
}

export interface SdrMeeting {
  id: string;
  prospect_id: string;
  prospect_name: string;
  prospect_email: string;
  founder_id: string;
  google_calendar_event_id: string | null;
  meeting_title: string;
  meeting_start_time: string;
  meeting_end_time: string;
  meeting_timezone: string;
  meeting_type: string;
  status: string;
  booking_source: string | null;
  calendly_event_uri: string | null;
  prep_summary: string | null;
  prep_sent_at: string | null;
  campaign_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

type NewMeeting = Omit<SdrMeeting, "id" | "created_at" | "updated_at">;

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

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

export async function fetchCalendarEvents(
  accessToken: string,
  timeMin: string,
  timeMax: string,
  calendarId = "primary",
): Promise<GoogleCalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  const res = await fetch(
    `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Calendar events fetch failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { items?: GoogleCalendarEvent[] };
  return data.items ?? [];
}

export async function createCalendarEvent(
  accessToken: string,
  event: Partial<GoogleCalendarEvent> & { summary: string; start: { dateTime: string }; end: { dateTime: string } },
  calendarId = "primary",
): Promise<GoogleCalendarEvent> {
  const res = await fetch(
    `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Calendar event creation failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<GoogleCalendarEvent>;
}

export async function getFounderFreeBusy(
  accessToken: string,
  timeMin: string,
  timeMax: string,
): Promise<FreeBusySlot[]> {
  const res = await fetch(`${GCAL_BASE}/freeBusy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin, timeMax, items: [{ id: "primary" }] }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Calendar freeBusy failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as {
    calendars?: { primary?: { busy?: FreeBusySlot[] } };
  };
  return data.calendars?.primary?.busy ?? [];
}

export async function storeMeeting(meeting: NewMeeting): Promise<SdrMeeting> {
  const { rows } = await getPool().query(
    `INSERT INTO sdr_meetings (
       prospect_id, prospect_name, prospect_email, founder_id,
       google_calendar_event_id, meeting_title, meeting_start_time,
       meeting_end_time, meeting_timezone, meeting_type, status,
       booking_source, calendly_event_uri, prep_summary, prep_sent_at,
       campaign_id, notes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      meeting.prospect_id,
      meeting.prospect_name,
      meeting.prospect_email,
      meeting.founder_id,
      meeting.google_calendar_event_id,
      meeting.meeting_title,
      meeting.meeting_start_time,
      meeting.meeting_end_time,
      meeting.meeting_timezone,
      meeting.meeting_type,
      meeting.status,
      meeting.booking_source,
      meeting.calendly_event_uri,
      meeting.prep_summary,
      meeting.prep_sent_at,
      meeting.campaign_id,
      meeting.notes,
    ],
  );
  return rows[0] as SdrMeeting;
}

export async function listMeetings(
  founderId: string,
  limit = 50,
  status?: string,
): Promise<SdrMeeting[]> {
  try {
    const params: unknown[] = [founderId];
    let statusClause = "";
    if (status) {
      params.push(status);
      statusClause = ` AND status = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await getPool().query(
      `SELECT * FROM sdr_meetings
        WHERE founder_id = $1${statusClause}
        ORDER BY meeting_start_time DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows as SdrMeeting[];
  } catch {
    return [];
  }
}

export async function getMeeting(meetingId: string): Promise<SdrMeeting | null> {
  try {
    const { rows } = await getPool().query(
      "SELECT * FROM sdr_meetings WHERE id = $1 LIMIT 1",
      [meetingId],
    );
    return (rows[0] as SdrMeeting) ?? null;
  } catch {
    return null;
  }
}

export async function updateMeetingStatus(
  meetingId: string,
  status: string,
): Promise<void> {
  await getPool().query(
    "UPDATE sdr_meetings SET status = $1, updated_at = now() WHERE id = $2",
    [status, meetingId],
  );
}

export async function syncBookingConfirmation(
  accessToken: string,
  calendarEventId: string,
  prospectEmail: string,
  prospectName: string,
  founderId: string,
  campaignId?: string,
): Promise<SdrMeeting> {
  const res = await fetch(
    `${GCAL_BASE}/calendars/primary/events/${encodeURIComponent(calendarEventId)}`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch Google Calendar event (${res.status}): ${body}`);
  }
  const event = (await res.json()) as GoogleCalendarEvent;

  return storeMeeting({
    prospect_id: crypto.randomUUID(),
    prospect_name: prospectName,
    prospect_email: prospectEmail,
    founder_id: founderId,
    google_calendar_event_id: event.id,
    meeting_title: event.summary ?? "Discovery Call",
    meeting_start_time: event.start.dateTime,
    meeting_end_time: event.end.dateTime,
    meeting_timezone: event.start.timeZone ?? "UTC",
    meeting_type: "discovery",
    status: "scheduled",
    booking_source: "google_calendar",
    calendly_event_uri: null,
    prep_summary: null,
    prep_sent_at: null,
    campaign_id: campaignId ?? null,
    notes: event.description ?? null,
  });
}

export function getAvailabilityContext(
  meetings: SdrMeeting[],
  bookingUrl: string,
): string {
  const now = new Date();
  const upcoming = meetings.filter(
    (m) => new Date(m.meeting_start_time) > now && m.status === "scheduled",
  );
  const lines: string[] = [
    `Founder has ${upcoming.length} upcoming call(s) scheduled.`,
    `Book a call: ${bookingUrl}`,
  ];
  if (upcoming.length > 0) {
    const next = upcoming[upcoming.length - 1];
    const dateStr = new Date(next.meeting_start_time).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    lines.push(`Next: ${next.meeting_title} with ${next.prospect_name} on ${dateStr}`);
  }
  return lines.join("\n");
}
