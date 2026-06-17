/**
 * Domain warm-up automation for SDR sending domains.
 *
 * Gradually increases daily send-volume limits for new dedicated sending
 * domains to build sender reputation before full-volume campaigns. Implements
 * the CTO research direction on 'domain warm-up automation' as part of the
 * deliverability risk mitigation strategy.
 */

import type { Db } from "@nexus/identity-and-access/api/_lib/db";

export interface WarmupScheduleEntry {
  dayStart: number;
  dayEnd: number;
  dailyLimit: number;
}

/**
 * Industry-standard warmup schedule: conservative start, doubling roughly
 * weekly. Day 31+ is considered graduated — the 500k cap is a practical
 * ceiling, not a platform limit.
 */
export const WARMUP_SCHEDULE: WarmupScheduleEntry[] = [
  { dayStart: 1,  dayEnd: 1,        dailyLimit: 50 },
  { dayStart: 2,  dayEnd: 2,        dailyLimit: 100 },
  { dayStart: 3,  dayEnd: 3,        dailyLimit: 200 },
  { dayStart: 4,  dayEnd: 4,        dailyLimit: 500 },
  { dayStart: 5,  dayEnd: 5,        dailyLimit: 1_000 },
  { dayStart: 6,  dayEnd: 7,        dailyLimit: 2_000 },
  { dayStart: 8,  dayEnd: 10,       dailyLimit: 5_000 },
  { dayStart: 11, dayEnd: 14,       dailyLimit: 10_000 },
  { dayStart: 15, dayEnd: 21,       dailyLimit: 25_000 },
  { dayStart: 22, dayEnd: 30,       dailyLimit: 50_000 },
  { dayStart: 31, dayEnd: 9_999_999, dailyLimit: 500_000 },
];

export interface DomainWarmupStatus {
  domainId: string;
  domain: string;
  warmupStartedAt: string;
  currentDay: number;
  dailyLimit: number;
  todaySentCount: number;
  remainingTodayCapacity: number;
  isWarmupComplete: boolean;
  warmupCompletedAt: string | null;
}

export interface WarmupProgressUpdate {
  domainId: string;
  domain: string;
  previousLimit: number;
  newLimit: number;
  currentDay: number;
  isComplete: boolean;
}

interface DomainRow {
  id: string;
  domain: string;
  warmup_started_at: string;
  warmup_completed_at: string | null;
  is_warmup_active: boolean;
  daily_limit: number;
}

interface TodaySentRow {
  domain_id: string;
  today_sent: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * Resolve the daily send limit for a given warmup day number (1-indexed).
 */
export function getDailyLimitForDay(warmupDay: number): number {
  for (const entry of WARMUP_SCHEDULE) {
    if (warmupDay >= entry.dayStart && warmupDay <= entry.dayEnd) {
      return entry.dailyLimit;
    }
  }
  return 500_000;
}

/** Compute which warmup day a domain is on given its start date. */
function computeWarmupDay(warmupStartedAt: string, now: Date): number {
  const started = new Date(warmupStartedAt);
  const elapsed = now.getTime() - started.getTime();
  return Math.max(1, Math.floor(elapsed / MS_PER_DAY) + 1);
}

/**
 * Fetch the current warmup status for a single sending domain.
 */
export async function getDomainWarmupStatus(
  db: Db,
  domainId: string
): Promise<DomainWarmupStatus | null> {
  const domains = await db.query<DomainRow>(
    `SELECT id, domain, warmup_started_at, warmup_completed_at,
            is_warmup_active, daily_limit
     FROM sdr_sending_domains
     WHERE id = $1`,
    domainId
  );

  if (domains.length === 0) return null;
  const row = domains[0];

  const now = new Date();
  const currentDay = computeWarmupDay(row.warmup_started_at, now);
  const dailyLimit = getDailyLimitForDay(currentDay);
  const isWarmupComplete = !row.is_warmup_active || currentDay > 30;

  const todaySentRows = await db.query<TodaySentRow>(
    `SELECT domain_id, COUNT(*) AS today_sent
     FROM sdr_email_events
     WHERE domain_id = $1
       AND event_type = 'sent'
       AND created_at >= CURRENT_DATE
     GROUP BY domain_id`,
    domainId
  );

  const todaySentCount =
    todaySentRows.length > 0 ? parseInt(todaySentRows[0].today_sent, 10) : 0;

  return {
    domainId: row.id,
    domain: row.domain,
    warmupStartedAt: row.warmup_started_at,
    currentDay,
    dailyLimit,
    todaySentCount,
    remainingTodayCapacity: Math.max(0, dailyLimit - todaySentCount),
    isWarmupComplete,
    warmupCompletedAt: row.warmup_completed_at ?? null,
  };
}

/**
 * Fetch warmup status for all actively warming sending domains in one pass.
 */
export async function getAllDomainWarmupStatuses(
  db: Db
): Promise<DomainWarmupStatus[]> {
  const domains = await db.query<DomainRow>(
    `SELECT id, domain, warmup_started_at, warmup_completed_at,
            is_warmup_active, daily_limit
     FROM sdr_sending_domains
     WHERE is_warmup_active = true
     ORDER BY warmup_started_at DESC`
  );

  if (domains.length === 0) return [];

  const domainIds = domains.map((d) => d.id);

  const todaySentRows = await db.query<TodaySentRow>(
    `SELECT domain_id, COUNT(*) AS today_sent
     FROM sdr_email_events
     WHERE domain_id = ANY($1)
       AND event_type = 'sent'
       AND created_at >= CURRENT_DATE
     GROUP BY domain_id`,
    domainIds
  );

  const sentByDomain = new Map<string, number>();
  for (const row of todaySentRows) {
    sentByDomain.set(row.domain_id, parseInt(row.today_sent, 10));
  }

  const now = new Date();

  return domains.map((row) => {
    const currentDay = computeWarmupDay(row.warmup_started_at, now);
    const dailyLimit = getDailyLimitForDay(currentDay);
    const todaySentCount = sentByDomain.get(row.id) ?? 0;
    const isWarmupComplete = !row.is_warmup_active || currentDay > 30;

    return {
      domainId: row.id,
      domain: row.domain,
      warmupStartedAt: row.warmup_started_at,
      currentDay,
      dailyLimit,
      todaySentCount,
      remainingTodayCapacity: Math.max(0, dailyLimit - todaySentCount),
      isWarmupComplete,
      warmupCompletedAt: row.warmup_completed_at ?? null,
    };
  });
}

/**
 * Update daily_limit for all actively warming domains whose schedule has
 * advanced, and graduate any domains that have completed 30+ days.
 *
 * Called by the deliverability-check cron to keep limits current without
 * requiring manual intervention.
 */
export async function updateWarmupProgress(db: Db): Promise<{
  updated: WarmupProgressUpdate[];
  completed: WarmupProgressUpdate[];
}> {
  const domains = await db.query<DomainRow>(
    `SELECT id, domain, warmup_started_at, warmup_completed_at,
            is_warmup_active, daily_limit
     FROM sdr_sending_domains
     WHERE is_warmup_active = true`
  );

  const now = new Date();
  const updated: WarmupProgressUpdate[] = [];
  const completed: WarmupProgressUpdate[] = [];

  for (const row of domains) {
    const currentDay = computeWarmupDay(row.warmup_started_at, now);
    const newLimit = getDailyLimitForDay(currentDay);
    const previousLimit = Number(row.daily_limit);
    const isComplete = currentDay > 30;

    if (isComplete) {
      await db.execute(
        `UPDATE sdr_sending_domains
         SET is_warmup_active   = false,
             warmup_completed_at = NOW(),
             daily_limit        = $2,
             updated_at         = NOW()
         WHERE id = $1`,
        row.id,
        newLimit
      );
      completed.push({
        domainId: row.id,
        domain: row.domain,
        previousLimit,
        newLimit,
        currentDay,
        isComplete: true,
      });
    } else if (newLimit !== previousLimit) {
      await db.execute(
        `UPDATE sdr_sending_domains
         SET daily_limit = $2,
             updated_at  = NOW()
         WHERE id = $1`,
        row.id,
        newLimit
      );
      updated.push({
        domainId: row.id,
        domain: row.domain,
        previousLimit,
        newLimit,
        currentDay,
        isComplete: false,
      });
    }
  }

  return { updated, completed };
}
