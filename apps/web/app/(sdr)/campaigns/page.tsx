import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import { listCampaignMetrics, formatPct } from "@/lib/sdr/campaign-metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function CampaignsPage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const campaigns = await listCampaignMetrics();

  return (
    <main>
      <h1>Campaign Performance</h1>
      <p>
        Meetings booked, engagement rates, and deliverability health across all
        outbound campaigns.
      </p>

      {campaigns.length === 0 ? (
        <div className="empty">
          <p>No campaigns yet.</p>
          <p className="muted">
            Create your first campaign to start tracking performance metrics.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Status</th>
              <th>Prospects</th>
              <th>Open Rate</th>
              <th>Reply Rate</th>
              <th>Meetings</th>
              <th>Completion</th>
              <th>Bounce Rate</th>
              <th>Spam Rate</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/campaigns/${encodeURIComponent(c.id)}`}>
                    {c.name}
                  </Link>
                </td>
                <td>
                  <span className="muted">{c.status}</span>
                </td>
                <td>{c.prospects_contacted}</td>
                <td>{formatPct(c.open_rate)}</td>
                <td>{formatPct(c.reply_rate)}</td>
                <td>
                  <strong>{c.meetings_booked}</strong>
                </td>
                <td>{formatPct(c.sequence_completion_rate)}</td>
                <td
                  style={
                    c.bounce_rate > 0.05
                      ? { color: "var(--substrate-danger)" }
                      : undefined
                  }
                >
                  {formatPct(c.bounce_rate)}
                </td>
                <td
                  style={
                    c.spam_complaint_rate > 0.001
                      ? { color: "var(--substrate-danger)" }
                      : undefined
                  }
                >
                  {formatPct(c.spam_complaint_rate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
