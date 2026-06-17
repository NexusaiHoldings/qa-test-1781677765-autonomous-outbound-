/** Analytics handlers — analytics-and-telemetry lego. Framework-agnostic. */
import type { HandlerContext, HandlerResult } from "./_lib/handler";
import { ok, err } from "./_lib/handler";
import type { DbRow } from "./_lib/db";

/** POST /api/analytics/events — record an event. */
export async function handleRecordEvent(
  ctx: HandlerContext,
  body: { name?: string; user_id?: string; properties?: Record<string, unknown> },
): Promise<HandlerResult> {
  const name = (body.name ?? "").trim();
  if (!name) return err(400, "name is required");
  const rows = await ctx.db.query<DbRow>(
    `INSERT INTO analytics_events (name, user_id, properties)
     VALUES ($1, $2, $3::jsonb) RETURNING id`,
    name, body.user_id ?? null, JSON.stringify(body.properties ?? {}),
  );
  await ctx.events.publish("analytics.event_recorded", { name });
  return ok({ event_id: rows[0].id }, 201);
}

/** GET /api/analytics/counts?name=&days= — event counts by day. */
export async function handleEventCounts(
  ctx: HandlerContext,
  query: { name?: string; days?: number },
): Promise<HandlerResult> {
  const days = Math.max(1, Math.min(90, query.days ?? 30));
  const params: unknown[] = [days];
  let nameClause = "";
  if (query.name) {
    params.push(query.name);
    nameClause = ` AND name = $${params.length}`;
  }
  const rows = await ctx.db.query<DbRow>(
    `SELECT name, DATE(occurred_at) AS day, COUNT(*) AS count
     FROM analytics_events
     WHERE occurred_at > NOW() - ($1 || ' days')::interval${nameClause}
     GROUP BY name, DATE(occurred_at) ORDER BY day DESC`,
    ...params,
  );
  return ok({ counts: rows });
}

/** GET /api/analytics/funnels — list defined funnels. */
export async function handleListFunnels(
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const rows = await ctx.db.query<DbRow>(
    `SELECT id, name, steps, created_at FROM analytics_funnels ORDER BY name`,
  );
  return ok({ funnels: rows, count: rows.length });
}
