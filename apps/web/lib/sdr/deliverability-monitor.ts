/**
 * Deliverability health monitor for SDR campaigns.
 *
 * Tracks per-campaign bounce rate, spam complaint rate, and unsubscribe rate
 * against configurable thresholds. Auto-pauses campaigns that exceed the 5%
 * bounce rate or 0.1% spam complaint rate to protect the sender's domain
 * reputation — the primary deliverability risk mitigation strategy per CTO
 * research direction on dedicated sending domains.
 */

import type { Db } from "@nexus/identity-and-access/api/_lib/db";

export interface DeliverabilityThresholds {
  /** Fraction, e.g. 0.05 = 5% */
  maxBounceRate: number;
  /** Fraction, e.g. 0.001 = 0.1% */
  maxSpamComplaintRate: number;
  /** Fraction, e.g. 0.02 = 2% */
  maxUnsubscribeRate: number;
}

export interface CampaignHealthMetrics {
  campaignId: string;
  campaignName: string;
  status: string;
  totalSent: number;
  bounceCount: number;
  spamComplaintCount: number;
  unsubscribeCount: number;
  bounceRate: number;
  spamComplaintRate: number;
  unsubscribeRate: number;
  healthStatus: "healthy" | "warning" | "at_risk" | "paused_auto";
  pausedReason: string | null;
}

export interface DeliverabilityCheckResult {
  checkedAt: string;
  campaignsChecked: number;
  campaignsPausedThisRun: number;
  campaignsAtRisk: number;
  metrics: CampaignHealthMetrics[];
}

export const DEFAULT_THRESHOLDS: DeliverabilityThresholds = {
  maxBounceRate: 0.05,         // 5% — industry hard limit
  maxSpamComplaintRate: 0.001, // 0.1% — Google/Yahoo enforcement threshold
  maxUnsubscribeRate: 0.02,    // 2% — soft warning threshold
};

/** Minimum sends before rate evaluation kicks in — avoids false positives on tiny batches. */
const MIN_SENDS_FOR_EVALUATION = 10;

interface CampaignRow {
  id: string;
  name: string;
  status: string;
}

interface EventCountRow {
  campaign_id: string;
  total_sent: string;
  bounce_count: string;
  spam_complaint_count: string;
  unsubscribe_count: string;
}

/**
 * Run a full deliverability check across all active campaigns.
 * Campaigns breaching hard thresholds are auto-paused and marked paused_auto.
 */
export async function runDeliverabilityCheck(
  db: Db,
  thresholds: DeliverabilityThresholds = DEFAULT_THRESHOLDS
): Promise<DeliverabilityCheckResult> {
  const checkedAt = new Date().toISOString();

  const campaigns = await db.query<CampaignRow>(
    `SELECT id, name, status
     FROM sdr_campaigns
     WHERE status IN ('active', 'sending', 'scheduled', 'paused_auto')
     ORDER BY created_at DESC
     LIMIT 500`
  );

  if (campaigns.length === 0) {
    return {
      checkedAt,
      campaignsChecked: 0,
      campaignsPausedThisRun: 0,
      campaignsAtRisk: 0,
      metrics: [],
    };
  }

  const campaignIds = campaigns.map((c) => c.id);

  const eventCounts = await db.query<EventCountRow>(
    `SELECT
       campaign_id,
       COUNT(*) FILTER (WHERE event_type = 'sent')            AS total_sent,
       COUNT(*) FILTER (WHERE event_type = 'bounced')         AS bounce_count,
       COUNT(*) FILTER (WHERE event_type = 'spam_complaint')  AS spam_complaint_count,
       COUNT(*) FILTER (WHERE event_type = 'unsubscribed')    AS unsubscribe_count
     FROM sdr_email_events
     WHERE campaign_id = ANY($1)
     GROUP BY campaign_id`,
    campaignIds
  );

  const countsByCampaign = new Map<string, EventCountRow>();
  for (const row of eventCounts) {
    countsByCampaign.set(row.campaign_id, row);
  }

  const metrics: CampaignHealthMetrics[] = [];
  let campaignsPausedThisRun = 0;
  let campaignsAtRisk = 0;

  for (const campaign of campaigns) {
    const counts = countsByCampaign.get(campaign.id);
    const totalSent = counts ? parseInt(counts.total_sent, 10) : 0;
    const bounceCount = counts ? parseInt(counts.bounce_count, 10) : 0;
    const spamComplaintCount = counts ? parseInt(counts.spam_complaint_count, 10) : 0;
    const unsubscribeCount = counts ? parseInt(counts.unsubscribe_count, 10) : 0;

    const bounceRate = totalSent > 0 ? bounceCount / totalSent : 0;
    const spamComplaintRate = totalSent > 0 ? spamComplaintCount / totalSent : 0;
    const unsubscribeRate = totalSent > 0 ? unsubscribeCount / totalSent : 0;

    let healthStatus: CampaignHealthMetrics["healthStatus"] = "healthy";
    let pausedReason: string | null = null;

    const hasEnoughData = totalSent >= MIN_SENDS_FOR_EVALUATION;
    const exceedsHardThreshold =
      hasEnoughData &&
      campaign.status !== "paused_auto" &&
      (bounceRate > thresholds.maxBounceRate ||
        spamComplaintRate > thresholds.maxSpamComplaintRate);

    if (exceedsHardThreshold) {
      const reasons: string[] = [];
      if (bounceRate > thresholds.maxBounceRate) {
        reasons.push(
          `bounce rate ${(bounceRate * 100).toFixed(2)}% exceeds ${(thresholds.maxBounceRate * 100).toFixed(1)}% threshold`
        );
      }
      if (spamComplaintRate > thresholds.maxSpamComplaintRate) {
        reasons.push(
          `spam complaint rate ${(spamComplaintRate * 100).toFixed(3)}% exceeds ${(thresholds.maxSpamComplaintRate * 100).toFixed(2)}% threshold`
        );
      }
      pausedReason = reasons.join("; ");
      healthStatus = "paused_auto";
      await pauseCampaign(db, campaign.id, pausedReason);
      campaignsPausedThisRun++;
    } else if (campaign.status === "paused_auto") {
      healthStatus = "paused_auto";
    } else if (
      hasEnoughData &&
      (bounceRate > thresholds.maxBounceRate * 0.75 ||
        spamComplaintRate > thresholds.maxSpamComplaintRate * 0.75 ||
        unsubscribeRate > thresholds.maxUnsubscribeRate)
    ) {
      healthStatus = "at_risk";
      campaignsAtRisk++;
    } else if (
      hasEnoughData &&
      (bounceRate > thresholds.maxBounceRate * 0.5 ||
        spamComplaintRate > thresholds.maxSpamComplaintRate * 0.5)
    ) {
      healthStatus = "warning";
    }

    metrics.push({
      campaignId: campaign.id,
      campaignName: campaign.name,
      status: exceedsHardThreshold ? "paused_auto" : campaign.status,
      totalSent,
      bounceCount,
      spamComplaintCount,
      unsubscribeCount,
      bounceRate,
      spamComplaintRate,
      unsubscribeRate,
      healthStatus,
      pausedReason,
    });
  }

  return {
    checkedAt,
    campaignsChecked: campaigns.length,
    campaignsPausedThisRun,
    campaignsAtRisk,
    metrics,
  };
}

/**
 * Pause a campaign by setting its status to paused_auto and recording the reason.
 */
export async function pauseCampaign(
  db: Db,
  campaignId: string,
  reason: string
): Promise<void> {
  await db.execute(
    `UPDATE sdr_campaigns
     SET status       = 'paused_auto',
         paused_reason = $2,
         paused_at    = NOW(),
         updated_at   = NOW()
     WHERE id = $1`,
    campaignId,
    reason
  );
}

/**
 * Fetch health metrics for a single campaign.
 */
export async function getCampaignHealthStatus(
  db: Db,
  campaignId: string,
  thresholds: DeliverabilityThresholds = DEFAULT_THRESHOLDS
): Promise<CampaignHealthMetrics | null> {
  const campaigns = await db.query<CampaignRow>(
    `SELECT id, name, status FROM sdr_campaigns WHERE id = $1`,
    campaignId
  );

  if (campaigns.length === 0) return null;
  const campaign = campaigns[0];

  const eventCounts = await db.query<EventCountRow>(
    `SELECT
       campaign_id,
       COUNT(*) FILTER (WHERE event_type = 'sent')            AS total_sent,
       COUNT(*) FILTER (WHERE event_type = 'bounced')         AS bounce_count,
       COUNT(*) FILTER (WHERE event_type = 'spam_complaint')  AS spam_complaint_count,
       COUNT(*) FILTER (WHERE event_type = 'unsubscribed')    AS unsubscribe_count
     FROM sdr_email_events
     WHERE campaign_id = $1
     GROUP BY campaign_id`,
    campaignId
  );

  const counts = eventCounts[0] ?? null;
  const totalSent = counts ? parseInt(counts.total_sent, 10) : 0;
  const bounceCount = counts ? parseInt(counts.bounce_count, 10) : 0;
  const spamComplaintCount = counts ? parseInt(counts.spam_complaint_count, 10) : 0;
  const unsubscribeCount = counts ? parseInt(counts.unsubscribe_count, 10) : 0;

  const bounceRate = totalSent > 0 ? bounceCount / totalSent : 0;
  const spamComplaintRate = totalSent > 0 ? spamComplaintCount / totalSent : 0;
  const unsubscribeRate = totalSent > 0 ? unsubscribeCount / totalSent : 0;

  const hasEnoughData = totalSent >= MIN_SENDS_FOR_EVALUATION;

  let healthStatus: CampaignHealthMetrics["healthStatus"] = "healthy";
  if (campaign.status === "paused_auto") {
    healthStatus = "paused_auto";
  } else if (
    hasEnoughData &&
    (bounceRate > thresholds.maxBounceRate ||
      spamComplaintRate > thresholds.maxSpamComplaintRate)
  ) {
    healthStatus = "at_risk";
  } else if (
    hasEnoughData &&
    (bounceRate > thresholds.maxBounceRate * 0.75 ||
      spamComplaintRate > thresholds.maxSpamComplaintRate * 0.75 ||
      unsubscribeRate > thresholds.maxUnsubscribeRate)
  ) {
    healthStatus = "at_risk";
  } else if (
    hasEnoughData &&
    (bounceRate > thresholds.maxBounceRate * 0.5 ||
      spamComplaintRate > thresholds.maxSpamComplaintRate * 0.5)
  ) {
    healthStatus = "warning";
  }

  return {
    campaignId: campaign.id,
    campaignName: campaign.name,
    status: campaign.status,
    totalSent,
    bounceCount,
    spamComplaintCount,
    unsubscribeCount,
    bounceRate,
    spamComplaintRate,
    unsubscribeRate,
    healthStatus,
    pausedReason: null,
  };
}
