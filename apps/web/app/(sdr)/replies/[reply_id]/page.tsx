/**
 * /replies/[reply_id] — Reply Detail + Coaching View
 *
 * Server component. Shows the full email content for a detected reply along
 * with:
 *   - Classification category and confidence score
 *   - One-sentence summary from the classifier
 *   - Coaching context (visible only for genuine-interest replies) — actionable
 *     advice for the founder on how to follow up
 *   - Suppression confirmation if the prospect unsubscribed
 */

import { notFound, redirect } from "next/navigation";
import { getAdminUser } from "@/lib/admin-auth";
import { buildDb } from "@/lib/db";

interface ReplyRow {
  id: string;
  source: string;
  message_id: string;
  thread_id: string | null;
  from_email: string;
  from_name: string | null;
  to_email: string;
  subject: string;
  body_text: string;
  received_at: string;
  category: string;
  confidence: number;
  summary: string | null;
  coaching_context: string | null;
  sequence_paused: boolean;
  created_at: string;
}

interface SuppressionRow {
  email: string;
  created_at: string;
}

async function fetchReply(replyId: string): Promise<ReplyRow | null> {
  const db = buildDb();
  try {
    const rows = await db.query<ReplyRow>(
      `SELECT id, source, message_id, thread_id, from_email, from_name,
              to_email, subject, body_text, received_at, category,
              confidence, summary, coaching_context, sequence_paused, created_at
       FROM sdr_replies
       WHERE id = $1
       LIMIT 1`,
      replyId,
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function fetchSuppression(email: string): Promise<SuppressionRow | null> {
  const db = buildDb();
  try {
    const rows = await db.query<SuppressionRow>(
      `SELECT email, created_at FROM sdr_suppression WHERE email = $1 LIMIT 1`,
      email,
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  genuine_interest: "Genuine Interest",
  ooo: "Out of Office",
  unsubscribe: "Unsubscribe Request",
  objection: "Objection",
};

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  genuine_interest:
    "This prospect expressed real interest. Their sequence has been paused — review the coaching notes below and respond personally.",
  ooo: "This is an automated out-of-office reply. No action needed; the sequence will resume when appropriate.",
  unsubscribe:
    "The prospect asked to be removed from your list. They have been added to your suppression list automatically.",
  objection:
    "The prospect replied with a concern or objection. Consider whether to address it or remove them from the sequence.",
};

interface PageProps {
  params: { reply_id: string };
}

export default async function ReplyDetailPage({ params }: PageProps) {
  const user = await getAdminUser();
  if (!user) redirect("/login");

  const reply = await fetchReply(params.reply_id);
  if (!reply) notFound();

  const suppression =
    reply.category === "unsubscribe"
      ? await fetchSuppression(reply.from_email)
      : null;

  const confidencePct = Math.round(reply.confidence * 100);

  return (
    <main>
      <p>
        <a href="/replies" className="muted">
          ← Back to Reply Inbox
        </a>
      </p>

      <h1>{reply.subject || "(no subject)"}</h1>
      <p>
        From{" "}
        <strong>
          {reply.from_name
            ? `${reply.from_name} <${reply.from_email}>`
            : reply.from_email}
        </strong>{" "}
        ·{" "}
        {new Date(reply.received_at).toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </p>

      {/* Classification card */}
      <div className="card">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 8,
          }}
        >
          <span
            style={{
              padding: "4px 12px",
              borderRadius: "4px",
              fontSize: "13px",
              fontWeight: 700,
              background:
                reply.category === "genuine_interest"
                  ? "#d1fae5"
                  : reply.category === "unsubscribe"
                    ? "#fee2e2"
                    : reply.category === "ooo"
                      ? "#fef9c3"
                      : "#f3f4f6",
              color:
                reply.category === "genuine_interest"
                  ? "#065f46"
                  : reply.category === "unsubscribe"
                    ? "#991b1b"
                    : reply.category === "ooo"
                      ? "#92400e"
                      : "#374151",
            }}
          >
            {CATEGORY_LABELS[reply.category] ?? reply.category}
          </span>
          <span className="muted" style={{ fontSize: "13px" }}>
            {confidencePct}% confidence · via{" "}
            {reply.source === "gmail" ? "Gmail" : "Outlook"}
          </span>
          {reply.sequence_paused && (
            <span
              style={{
                fontSize: "13px",
                color: "#6b7280",
                background: "#f3f4f6",
                padding: "2px 10px",
                borderRadius: 4,
              }}
            >
              ⏸ Sequence paused
            </span>
          )}
        </div>

        <p style={{ margin: 0 }}>
          {CATEGORY_DESCRIPTIONS[reply.category] ??
            "Review this reply and decide on next steps."}
        </p>

        {reply.summary && (
          <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
            <strong>Summary:</strong> {reply.summary}
          </p>
        )}
      </div>

      {/* Coaching context — only for genuine interest */}
      {reply.category === "genuine_interest" && reply.coaching_context && (
        <div
          className="card"
          style={{ borderLeft: "4px solid #2563eb", background: "#eff6ff" }}
        >
          <h2 style={{ marginTop: 0, color: "#1e40af", fontSize: "16px" }}>
            Coaching Notes
          </h2>
          <p style={{ margin: 0, color: "#1e3a8a" }}>{reply.coaching_context}</p>
        </div>
      )}

      {/* Suppression confirmation */}
      {suppression && (
        <div
          className="card"
          style={{ borderLeft: "4px solid #dc2626", background: "#fef2f2" }}
        >
          <h2 style={{ marginTop: 0, color: "#991b1b", fontSize: "16px" }}>
            Suppression List
          </h2>
          <p style={{ margin: 0, color: "#7f1d1d" }}>
            <strong>{reply.from_email}</strong> was automatically added to your
            suppression list on{" "}
            {new Date(suppression.created_at).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
            . No further emails will be sent to this address.
          </p>
        </div>
      )}

      {/* Full email body */}
      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: "15px", color: "#374151" }}>
          Email Body
        </h2>
        <div
          style={{
            fontFamily: "monospace",
            fontSize: "14px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "#111827",
            lineHeight: 1.6,
          }}
        >
          {reply.body_text}
        </div>
      </div>

      {/* Metadata */}
      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: "15px", color: "#374151" }}>
          Metadata
        </h2>
        <table style={{ width: "100%", fontSize: "13px" }}>
          <tbody>
            <tr>
              <td className="muted" style={{ paddingRight: 16, width: 140 }}>
                To
              </td>
              <td>{reply.to_email}</td>
            </tr>
            <tr>
              <td className="muted">Message ID</td>
              <td style={{ fontFamily: "monospace", fontSize: "11px" }}>
                {reply.message_id}
              </td>
            </tr>
            {reply.thread_id && (
              <tr>
                <td className="muted">Thread ID</td>
                <td style={{ fontFamily: "monospace", fontSize: "11px" }}>
                  {reply.thread_id}
                </td>
              </tr>
            )}
            <tr>
              <td className="muted">Source</td>
              <td>{reply.source === "gmail" ? "Gmail" : "Outlook"}</td>
            </tr>
            <tr>
              <td className="muted">Detected at</td>
              <td>
                {new Date(reply.created_at).toLocaleString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
        <a href="/replies" className="btn secondary">
          ← Back to Inbox
        </a>
      </div>
    </main>
  );
}
