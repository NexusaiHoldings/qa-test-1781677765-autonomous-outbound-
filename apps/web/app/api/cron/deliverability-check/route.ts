/**
 * GET /api/cron/deliverability-check — background deliverability health monitor.
 *
 * Vercel Cron handler (schedule in vercel.json). Each invocation:
 *   1. Evaluates per-campaign bounce rate, spam complaint rate, and unsubscribe
 *      rate against configured thresholds.
 *   2. Auto-pauses any campaign that exceeds the 5% bounce or 0.1% spam
 *      complaint threshold to protect the sender's domain reputation.
 *   3. Advances domain warmup schedules — updates daily_limit for all actively
 *      warming sending domains and graduates any that have completed 30+ days.
 *
 * Auth: CRON_SECRET env var. When set, Vercel attaches
 * `Authorization: Bearer <CRON_SECRET>` to every cron invocation. When unset
 * (local/dev) the route runs unguarded.
 */

import { NextResponse } from "next/server";
import { buildDb } from "@/lib/db";
import {
  runDeliverabilityCheck,
  DEFAULT_THRESHOLDS,
} from "@/lib/sdr/deliverability-monitor";
import { updateWarmupProgress } from "@/lib/sdr/domain-warmup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // pg + raw SQL — not edge-compatible
export const maxDuration = 60;

function _cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // unguarded in dev; prod sets CRON_SECRET
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!_cronAuthorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const db = buildDb();
  const startedAt = Date.now();

  let deliverabilityResult;
  try {
    deliverabilityResult = await runDeliverabilityCheck(db, DEFAULT_THRESHOLDS);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "deliverability_check_failed",
        detail: String((e as Error).message).slice(0, 500),
      },
      { status: 500 }
    );
  }

  let warmupResult: {
    updated: { domainId: string; domain: string; previousLimit: number; newLimit: number; currentDay: number; isComplete: boolean }[];
    completed: { domainId: string; domain: string; previousLimit: number; newLimit: number; currentDay: number; isComplete: boolean }[];
    error?: string;
  };
  try {
    warmupResult = await updateWarmupProgress(db);
  } catch (e) {
    // Warmup errors are non-fatal — cron continues and reports the issue.
    warmupResult = {
      updated: [],
      completed: [],
      error: String((e as Error).message).slice(0, 500),
    };
  }

  const elapsedMs = Date.now() - startedAt;

  return NextResponse.json({
    ok: true,
    elapsedMs,
    deliverability: {
      checkedAt: deliverabilityResult.checkedAt,
      campaignsChecked: deliverabilityResult.campaignsChecked,
      campaignsPausedThisRun: deliverabilityResult.campaignsPausedThisRun,
      campaignsAtRisk: deliverabilityResult.campaignsAtRisk,
      metrics: deliverabilityResult.metrics.map((m) => ({
        campaignId: m.campaignId,
        campaignName: m.campaignName,
        status: m.status,
        healthStatus: m.healthStatus,
        bounceRate: parseFloat((m.bounceRate * 100).toFixed(3)),
        spamComplaintRate: parseFloat((m.spamComplaintRate * 100).toFixed(4)),
        unsubscribeRate: parseFloat((m.unsubscribeRate * 100).toFixed(3)),
        totalSent: m.totalSent,
        pausedReason: m.pausedReason,
      })),
    },
    warmup: {
      domainsUpdated: warmupResult.updated.length,
      domainsCompleted: warmupResult.completed.length,
      ...(warmupResult.error ? { error: warmupResult.error } : {}),
    },
  });
}
