/**
 * Meeting detail — SDR calendar integration (F1-009).
 *
 * Displays full meeting record, prospect information, Google Calendar event
 * metadata, and the auto-generated meeting prep summary.
 */
import type { JSX } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getMeeting } from "@/lib/sdr/calendar-sync";
import type { MeetingPrepSummary } from "@/lib/sdr/meeting-prep";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: { meeting_id: string };
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

function durationMinutes(start: string, end: string): number {
  try {
    return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000);
  } catch {
    return 0;
  }
}

function parsePrepSummary(raw: string | null): MeetingPrepSummary | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MeetingPrepSummary;
  } catch {
    return null;
  }
}

export default async function MeetingDetailPage({ params }: PageProps): Promise<JSX.Element> {
  const meeting = await getMeeting(params.meeting_id);
  if (!meeting) notFound();

  const prepSummary = parsePrepSummary(meeting.prep_summary);
  const durationMin = durationMinutes(meeting.meeting_start_time, meeting.meeting_end_time);
  const formattedStart = formatDateTime(meeting.meeting_start_time);

  return (
    <main>
      <Link href="/meetings" className="btn secondary">
        ← Back to Meetings
      </Link>

      <h1>{meeting.meeting_title}</h1>
      <p>
        {formattedStart}
        {durationMin > 0 ? ` · ${durationMin} min` : ""}
        {" · "}
        <strong>{meeting.status}</strong>
      </p>

      <div className="card">
        <h2>Prospect</h2>
        <table>
          <tbody>
            <tr>
              <th>Name</th>
              <td>{meeting.prospect_name}</td>
            </tr>
            <tr>
              <th>Email</th>
              <td>
                <a href={`mailto:${meeting.prospect_email}`}>{meeting.prospect_email}</a>
              </td>
            </tr>
            <tr>
              <th>Booking source</th>
              <td>{meeting.booking_source ?? "—"}</td>
            </tr>
            {meeting.notes ? (
              <tr>
                <th>Notes</th>
                <td>{meeting.notes}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Calendar Details</h2>
        <table>
          <tbody>
            <tr>
              <th>Type</th>
              <td>{meeting.meeting_type}</td>
            </tr>
            <tr>
              <th>Timezone</th>
              <td>{meeting.meeting_timezone}</td>
            </tr>
            {meeting.google_calendar_event_id ? (
              <tr>
                <th>Google event ID</th>
                <td className="muted">{meeting.google_calendar_event_id}</td>
              </tr>
            ) : null}
            {meeting.calendly_event_uri ? (
              <tr>
                <th>Calendly URI</th>
                <td className="muted">{meeting.calendly_event_uri}</td>
              </tr>
            ) : null}
            {meeting.campaign_id ? (
              <tr>
                <th>Campaign</th>
                <td className="muted">{meeting.campaign_id}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Meeting Prep Summary</h2>
        {prepSummary ? (
          <>
            <div className="card">
              <h3>About Your Contact</h3>
              <p>{prepSummary.company_research}</p>
              <p className="muted">{prepSummary.background_notes}</p>
            </div>

            <h3>Talking Points</h3>
            <ul>
              {prepSummary.talking_points.map((point, idx) => (
                // eslint-disable-next-line react/no-array-index-key
                <li key={idx}>{point}</li>
              ))}
            </ul>

            <p className="muted">
              Generated on{" "}
              {new Date(prepSummary.generated_at).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
              {meeting.prep_sent_at
                ? ` · Emailed to founder on ${new Date(meeting.prep_sent_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
                : " · Email pending"}
            </p>
          </>
        ) : meeting.prep_summary ? (
          <p>{meeting.prep_summary}</p>
        ) : (
          <div className="empty">
            <p>
              Prep summary not yet generated. It will be created and emailed to the
              founder automatically 24 hours before the scheduled meeting.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
