/**
 * GET /api/cron/sequence-drip — Vercel Cron handler for the multi-touch
 * sequence drip scheduler (F1-006).
 *
 * Evaluates active SDR campaigns every 15 minutes and dispatches the next
 * sequence touch for each eligible prospect based on configured day-offset
 * delays (e.g. Day 1, Day 4, Day 8). Automatically pauses enrollments when a
 * reply is detected, preventing follow-up emails to engaged prospects.
 *
 * Auth: when CRON_SECRET is set, Vercel sends `Authorization: Bearer <secret>`;
 * we validate it. When unset (local/dev), the route runs unguarded.
 */

import { NextResponse } from "next/server";
import { scheduleDrip } from "@/lib/sdr/drip-scheduler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // pg + Node crypto — not edge-compatible
export const maxDuration = 60;

function isCronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const startedAt = Date.now();

  let result;
  try {
    result = await scheduleDrip(100);
  } catch (err) {
    const msg = String((err as Error).message).slice(0, 500);
    console.error(
      JSON.stringify({ level: "error", msg: "drip_scheduler_failed", error: msg })
    );
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const durationMs = Date.now() - startedAt;
  console.error(
    JSON.stringify({
      level: "info",
      msg: "drip_scheduler_complete",
      dispatched: result.dispatched,
      skipped: result.skipped,
      paused: result.paused,
      errors: result.errors,
      durationMs,
    })
  );

  return NextResponse.json({
    ok: true,
    dispatched: result.dispatched,
    skipped: result.skipped,
    paused: result.paused,
    errors: result.errors,
    durationMs,
  });
}
