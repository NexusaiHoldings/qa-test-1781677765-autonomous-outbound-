/**
 * Meetings list — SDR calendar integration (F1-009).
 *
 * Shows all booked prospect calls pulled from sdr_meetings, separated into
 * upcoming and past sections. Plain semantic HTML; styled by the substrate's
 * globals.css element defaults (no Tailwind).
 */
import type { JSX } from "react";
import Link from "next/link";
import { getSessionUser } from "@/lib/admin-auth";
import { listMeetings, type SdrMeeting } from "@/lib/sdr/calendar-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    scheduled: "Scheduled",
    completed: "Completed",
    cancelled: "Cancelled",
    no_show: "No Show",
    rescheduled: "Rescheduled",
  };
  return map[status] ?? status;
}

function MeetingRow({ meeting }: { meeting: SdrMeeting }): JSX.Element {
  return (
    <tr>
      <td>
        <Link href={`/meetings/${meeting.id}`}>{meeting.meeting_title}</Link>
      </td>
      <td>
        <div>{meeting.prospect_name}</div>
        <div className="muted">{meeting.prospect_email}</div>
      </td>
      <td>{formatDate(meeting.meeting_start_time)}</td>
      <td>{statusLabel(meeting.status)}</td>
      <td>
        {meeting.prep_sent_at ? (
          <span>Sent</span>
        ) : (
          <span className="muted">Pending</span>
        )}
      </td>
      <td>
        <Link href={`/meetings/${meeting.id}`} className="btn secondary">
          View
        </Link>
      </td>
    </tr>
  );
}

export default async function MeetingsPage(): Promise<JSX.Element> {
  const user = await getSessionUser();

  if (!user) {
    return (
      <main>
        <h1>Meetings</h1>
        <p>Please <Link href="/login">sign in</Link> to view your meetings.</p>
      </main>
    );
  }

  const meetings = await listMeetings(user.id, 100);
  const now = new Date();
  const upcoming = meetings.filter(
    (m) => new Date(m.meeting_start_time) >= now && m.status === "scheduled",
  );
  const past = meetings.filter(
    (m) => new Date(m.meeting_start_time) < now || m.status !== "scheduled",
  );

  return (
    <main>
      <h1>Meetings</h1>
      <p>
        Booked prospect calls with automated prep summaries. Meetings are synced
        from Google Calendar and stored for pipeline review.
      </p>

      <section>
        <h2>Upcoming ({upcoming.length})</h2>
        {upcoming.length === 0 ? (
          <div className="empty">
            <p>
              No upcoming meetings scheduled. Meetings appear here once prospects
              book through your calendar link.
            </p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Prospect</th>
                <th>Date &amp; Time</th>
                <th>Status</th>
                <th>Prep</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {upcoming.map((m) => (
                <MeetingRow key={m.id} meeting={m} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {past.length > 0 && (
        <section>
          <h2>Past Meetings ({past.length})</h2>
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Prospect</th>
                <th>Date &amp; Time</th>
                <th>Status</th>
                <th>Prep</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {past.map((m) => (
                <MeetingRow key={m.id} meeting={m} />
              ))}
            </tbody>
          </table>
        </section>
      )}

      {meetings.length === 0 && (
        <div className="empty">
          <p>
            No meetings yet. Configure your Google Calendar integration and share
            your booking link with prospects to get started.
          </p>
        </div>
      )}
    </main>
  );
}
