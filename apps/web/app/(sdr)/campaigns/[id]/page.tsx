import type { JSX } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import { getCampaignDetail, formatPct } from "@/lib/sdr/campaign-metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function MetricCard({
  label,
  value,
  highlight,
  danger,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  danger?: boolean;
}): JSX.Element {
  return (
    <div
      className="card"
      style={
        highlight
          ? { borderColor: "var(--substrate-accent)" }
          : danger
            ? { borderColor: "var(--substrate-danger)" }
            : undefined
      }
    >
      <p className="muted" style={{ marginBottom: "4px", fontSize: "0.8rem" }}>
        {label}
      </p>
      <p
        style={{
          fontSize: "1.5rem",
          fontWeight: 700,
          color: danger ? "var(--substrate-danger)" : undefined,
        }}
      >
        {value}
      </p>
    </div>
  );
}

export default async function CampaignDetailPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const campaign = await getCampaignDetail(params.id);
  if (!campaign) notFound();

  const highBounce = campaign.bounce_rate > 0.05;
  const highSpam = campaign.spam_complaint_rate > 0.001;

  return (
    <main>
      <Link href="/campaigns" className="muted">
        ← All campaigns
      </Link>

      <h1>{campaign.name}</h1>
      <p>
        {campaign.description ??
          "Campaign performance — prospects contacted, engagement, and deliverability health."}
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
          gap: "1rem",
          margin: "1.5rem 0",
        }}
      >
        <MetricCard
          label="Prospects Contacted"
          value={String(campaign.prospects_contacted)}
        />
        <MetricCard
          label="Meetings Booked"
          value={String(campaign.meetings_booked)}
          highlight
        />
        <MetricCard label="Open Rate" value={formatPct(campaign.open_rate)} />
        <MetricCard
          label="Reply Rate"
          value={formatPct(campaign.reply_rate)}
        />
        <MetricCard
          label="Sequence Completion"
          value={formatPct(campaign.sequence_completion_rate)}
        />
        <MetricCard
          label="Bounce Rate"
          value={formatPct(campaign.bounce_rate)}
          danger={highBounce}
        />
        <MetricCard
          label="Spam Complaint Rate"
          value={formatPct(campaign.spam_complaint_rate)}
          danger={highSpam}
        />
      </div>

      {(highBounce || highSpam) && (
        <div
          className="card"
          style={{ borderColor: "var(--substrate-danger)" }}
        >
          <p>
            <strong>Deliverability alert</strong>
          </p>
          {highBounce && (
            <p className="muted">
              Bounce rate {formatPct(campaign.bounce_rate)} exceeds 5% threshold
              — review your contact list hygiene.
            </p>
          )}
          {highSpam && (
            <p className="muted">
              Spam complaint rate {formatPct(campaign.spam_complaint_rate)}{" "}
              exceeds 0.1% — review sending frequency and unsubscribe flow.
            </p>
          )}
        </div>
      )}

      <table style={{ marginTop: "1.5rem" }}>
        <thead>
          <tr>
            <th>Metric</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Emails sent</td>
            <td>{campaign.emails_sent}</td>
          </tr>
          <tr>
            <td>Emails opened</td>
            <td>{campaign.emails_opened}</td>
          </tr>
          <tr>
            <td>Replies received</td>
            <td>{campaign.emails_replied}</td>
          </tr>
          <tr>
            <td>Meetings booked</td>
            <td>{campaign.meetings_booked}</td>
          </tr>
          <tr>
            <td>Sequences completed</td>
            <td>{campaign.sequences_completed}</td>
          </tr>
          <tr>
            <td>Bounces</td>
            <td
              style={
                highBounce ? { color: "var(--substrate-danger)" } : undefined
              }
            >
              {campaign.bounces}
            </td>
          </tr>
          <tr>
            <td>Spam complaints</td>
            <td
              style={
                highSpam ? { color: "var(--substrate-danger)" } : undefined
              }
            >
              {campaign.spam_complaints}
            </td>
          </tr>
        </tbody>
      </table>

      <p style={{ marginTop: "1.5rem" }}>
        <Link href="/campaigns" className="btn secondary">
          ← Back to campaigns
        </Link>
      </p>
    </main>
  );
}
