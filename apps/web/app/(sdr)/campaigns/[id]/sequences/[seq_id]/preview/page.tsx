import type { JSX } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSequenceById } from "@/lib/sdr/sequence-builder";

interface PageProps {
  params: {
    id: string;
    seq_id: string;
  };
}

const TOUCH_LABELS: Record<number, string> = {
  1: "Touch 1 — Initial Outreach",
  2: "Touch 2 — First Follow-up (3–5 days later)",
  3: "Touch 3 — Second Follow-up (7–10 days later)",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "#6b7280",
  active: "#059669",
  paused: "#d97706",
  completed: "#2563eb",
};

export default async function SequencePreviewPage({
  params,
}: PageProps): Promise<JSX.Element> {
  const sequence = await getSequenceById(params.seq_id).catch(() => null);

  if (!sequence || sequence.campaignId !== params.id) {
    notFound();
  }

  const statusColor = STATUS_COLORS[sequence.status] ?? "#6b7280";

  return (
    <main>
      <h1>
        {sequence.prospectFirstName} {sequence.prospectLastName} — Sequence Preview
      </h1>
      <p>
        {sequence.prospectRole} at <strong>{sequence.prospectCompany}</strong>
        {" · "}
        <span style={{ color: statusColor, fontWeight: 600 }}>
          {sequence.status}
        </span>
        {" · "}
        <span className="muted">
          Generated{" "}
          {new Date(sequence.generatedAt).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </span>
      </p>

      <div className="toolbar">
        <Link
          href={`/campaigns/${params.id}/sequences`}
          className="btn secondary"
        >
          ← All Sequences
        </Link>
        <Link href={`/campaigns/${params.id}`} className="btn secondary">
          Campaign
        </Link>
      </div>

      {sequence.emails[0]?.signal && (
        <div className="card">
          <strong>Prospect Signal (injected at generation time)</strong>
          <p>{sequence.emails[0].signal}</p>
          <span className="muted">
            This signal was retrieved via real-time news RAG over company RSS/news
            APIs and injected into every touch to avoid generic openers.
          </span>
        </div>
      )}

      {sequence.emails.map((email, idx) => (
        <div key={idx} className="card">
          <h2>{TOUCH_LABELS[email.touchNumber] ?? `Touch ${email.touchNumber}`}</h2>

          <table>
            <tbody>
              <tr>
                <th scope="row">Subject</th>
                <td>{email.subject}</td>
              </tr>
              <tr>
                <th scope="row">Personalization</th>
                <td>
                  <span className="muted">{email.personalizationField}</span>
                </td>
              </tr>
            </tbody>
          </table>

          <div style={{ marginTop: "1rem" }}>
            <strong>Body</strong>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                fontFamily: "inherit",
                fontSize: "0.9rem",
                background: "rgba(0,0,0,0.03)",
                padding: "1rem",
                borderRadius: "0.375rem",
                marginTop: "0.5rem",
                border: "1px solid rgba(0,0,0,0.08)",
              }}
            >
              {email.body}
            </pre>
          </div>
        </div>
      ))}
    </main>
  );
}
