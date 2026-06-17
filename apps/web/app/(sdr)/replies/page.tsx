/**
 * /replies — SDR Reply Inbox
 *
 * Server component. Surfaces inbound replies that have been classified by the
 * Gmail/Outlook webhooks. Defaults to showing genuine-interest replies so the
 * founder immediately sees who to follow up with, with an optional filter to
 * view all categories.
 */

import { redirect } from "next/navigation";
import { getAdminUser } from "@/lib/admin-auth";
import { buildDb } from "@/lib/db";

interface ReplyRow {
  id: string;
  source: string;
  from_email: string;
  from_name: string | null;
  to_email: string;
  subject: string;
  category: string;
  confidence: number;
  summary: string | null;
  coaching_context: string | null;
  sequence_paused: boolean;
  received_at: string;
  created_at: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  genuine_interest: "Genuine Interest",
  ooo: "Out of Office",
  unsubscribe: "Unsubscribe",
  objection: "Objection",
};

const SOURCE_LABELS: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
};

async function fetchReplies(category: string): Promise<ReplyRow[]> {
  const db = buildDb();
  try {
    if (category === "all") {
      return await db.query<ReplyRow>(
        `SELECT id, source, from_email, from_name, to_email, subject,
                category, confidence, summary, coaching_context,
                sequence_paused, received_at, created_at
         FROM sdr_replies
         ORDER BY received_at DESC
         LIMIT 200`,
      );
    }
    return await db.query<ReplyRow>(
      `SELECT id, source, from_email, from_name, to_email, subject,
              category, confidence, summary, coaching_context,
              sequence_paused, received_at, created_at
       FROM sdr_replies
       WHERE category = $1
       ORDER BY received_at DESC
       LIMIT 200`,
      category,
    );
  } catch {
    // Table may not exist yet (no replies received)
    return [];
  }
}

async function fetchCounts(): Promise<Record<string, number>> {
  const db = buildDb();
  try {
    const rows = await db.query<{ category: string; cnt: string }>(
      `SELECT category, COUNT(*) AS cnt FROM sdr_replies GROUP BY category`,
    );
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.category] = parseInt(row.cnt, 10);
    }
    return counts;
  } catch {
    return {};
  }
}

interface PageProps {
  searchParams?: { category?: string };
}

export default async function RepliesPage({ searchParams }: PageProps) {
  const user = await getAdminUser();
  if (!user) redirect("/login");

  const category = searchParams?.category ?? "genuine_interest";
  const [replies, counts] = await Promise.all([
    fetchReplies(category),
    fetchCounts(),
  ]);

  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <main>
      <h1>Reply Inbox</h1>
      <p>
        Inbound replies to your outreach sequences, classified and prioritised.
        Genuine-interest replies pause the sequence automatically so you can
        follow up personally.
      </p>

      <div className="toolbar">
        {[
          { key: "genuine_interest", label: "Genuine Interest" },
          { key: "objection", label: "Objections" },
          { key: "ooo", label: "Out of Office" },
          { key: "unsubscribe", label: "Unsubscribes" },
          { key: "all", label: "All" },
        ].map(({ key, label }) => (
          <a
            key={key}
            href={`/replies?category=${key}`}
            className={category === key ? "btn" : "btn secondary"}
          >
            {label}
            {key === "all"
              ? ` (${totalAll})`
              : counts[key]
                ? ` (${counts[key]})`
                : ""}
          </a>
        ))}
      </div>

      {replies.length === 0 ? (
        <div className="empty">
          <p>
            No{" "}
            {category === "all"
              ? ""
              : (CATEGORY_LABELS[category] ?? category).toLowerCase()}{" "}
            replies yet.
          </p>
          <p className="muted">
            Replies are detected automatically when prospects respond to your
            outreach emails via Gmail or Outlook.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>From</th>
              <th>Subject</th>
              <th>Category</th>
              <th>Source</th>
              <th>Received</th>
              <th>Summary</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {replies.map((reply) => (
              <tr key={reply.id}>
                <td>
                  <strong>{reply.from_name ?? reply.from_email}</strong>
                  {reply.from_name && (
                    <span className="muted"> &lt;{reply.from_email}&gt;</span>
                  )}
                </td>
                <td>{reply.subject}</td>
                <td>
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: "4px",
                      fontSize: "12px",
                      fontWeight: 600,
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
                  {reply.sequence_paused && (
                    <span
                      className="muted"
                      style={{ marginLeft: 6, fontSize: "11px" }}
                    >
                      ⏸ paused
                    </span>
                  )}
                </td>
                <td className="muted">
                  {SOURCE_LABELS[reply.source] ?? reply.source}
                </td>
                <td className="muted" style={{ whiteSpace: "nowrap" }}>
                  {new Date(reply.received_at).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </td>
                <td className="muted" style={{ maxWidth: 280 }}>
                  {reply.summary}
                </td>
                <td>
                  <a href={`/replies/${reply.id}`} className="btn secondary">
                    View
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
