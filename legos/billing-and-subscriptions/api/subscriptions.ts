/**
 * Subscription read + cancel/resume.
 *
 * Ported 2026-05-12 from api/subscriptions.py.
 * Webhook is canonical source of truth; this just reads state and forwards
 * cancel/resume to Stripe. Local state updates happen on webhook receipt.
 */

import { err, ok } from "./_lib/handler";
import type { HandlerContext, HandlerResult } from "./_lib/handler";
import { stripePost } from "./_lib/stripe";

interface SubRow {
  id: string;
  stripe_subscription_id: string;
  tier_name: string;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  trial_end: string | null;
}

function serialize(row: SubRow): Record<string, unknown> {
  return {
    id: row.id,
    stripe_subscription_id: row.stripe_subscription_id,
    tier_name: row.tier_name,
    status: row.status,
    current_period_start: row.current_period_start,
    current_period_end: row.current_period_end,
    cancel_at_period_end: row.cancel_at_period_end,
    trial_end: row.trial_end,
  };
}

export interface SubInput {
  readonly userId: string | null;
  readonly ctx: HandlerContext;
}

export async function handleGetSubscription({
  userId,
  ctx,
}: SubInput): Promise<HandlerResult> {
  if (!userId) return err(401, "authentication required");
  try {
    const rows = await ctx.db.query<SubRow>(
      "SELECT s.id, s.stripe_subscription_id, s.tier_name, s.status, " +
        "s.current_period_start, s.current_period_end, s.cancel_at_period_end, s.trial_end " +
        "FROM billing_subscriptions s JOIN billing_customers c ON c.id = s.customer_id " +
        "WHERE c.user_id = $1::uuid AND s.status IN ('trialing', 'active', 'past_due') " +
        "ORDER BY s.created_at DESC LIMIT 1",
      userId,
    );
    if (rows.length === 0) return ok({ subscription: null });
    return ok({ subscription: serialize(rows[0]) });
  } catch {
    return err(500, "internal error");
  }
}

export async function handleCancelSubscription({
  userId,
  ctx,
}: SubInput): Promise<HandlerResult> {
  if (!userId) return err(401, "authentication required");
  const secretKey = process.env.STRIPE_SECRET_KEY || "";
  if (!secretKey) return err(503, "stripe not configured");

  const rows = await ctx.db.query<{
    id: string;
    stripe_subscription_id: string;
    tier_name: string;
  }>(
    "SELECT s.id, s.stripe_subscription_id, s.tier_name FROM billing_subscriptions s " +
      "JOIN billing_customers c ON c.id = s.customer_id " +
      "WHERE c.user_id = $1::uuid AND s.status IN ('trialing', 'active') LIMIT 1",
    userId,
  );
  if (rows.length === 0) return err(404, "no active subscription found");
  const sub = rows[0];

  const resp = await stripePost(
    `subscriptions/${sub.stripe_subscription_id}`,
    { cancel_at_period_end: "true" },
    secretKey,
  );
  if (resp.status >= 400) {
    return err(502, "failed to schedule cancellation with stripe");
  }

  await ctx.db.execute(
    "UPDATE billing_subscriptions SET cancel_at_period_end = TRUE, updated_at = NOW() WHERE id = $1::uuid",
    sub.id,
  );

  await ctx.events.publish("billing.subscription_cancelled", {
    user_id: userId,
    stripe_subscription_id: sub.stripe_subscription_id,
    tier_name: sub.tier_name,
    cancellation_type: "scheduled",
  });

  return ok({
    status: "cancellation_scheduled",
    stripe_subscription_id: sub.stripe_subscription_id,
  });
}

export async function handleResumeSubscription({
  userId,
  ctx,
}: SubInput): Promise<HandlerResult> {
  if (!userId) return err(401, "authentication required");
  const secretKey = process.env.STRIPE_SECRET_KEY || "";
  if (!secretKey) return err(503, "stripe not configured");

  const rows = await ctx.db.query<{
    id: string;
    stripe_subscription_id: string;
    cancel_at_period_end: boolean;
  }>(
    "SELECT s.id, s.stripe_subscription_id, s.cancel_at_period_end FROM billing_subscriptions s " +
      "JOIN billing_customers c ON c.id = s.customer_id " +
      "WHERE c.user_id = $1::uuid AND s.status IN ('trialing', 'active') LIMIT 1",
    userId,
  );
  if (rows.length === 0) return err(404, "no active subscription");
  if (!rows[0].cancel_at_period_end) {
    return err(400, "subscription is not pending cancellation");
  }

  const resp = await stripePost(
    `subscriptions/${rows[0].stripe_subscription_id}`,
    { cancel_at_period_end: "false" },
    secretKey,
  );
  if (resp.status >= 400) return err(502, "failed to resume with stripe");

  await ctx.db.execute(
    "UPDATE billing_subscriptions SET cancel_at_period_end = FALSE, updated_at = NOW() WHERE id = $1::uuid",
    rows[0].id,
  );
  await ctx.events.publish("billing.subscription_updated", {
    user_id: userId,
    stripe_subscription_id: rows[0].stripe_subscription_id,
    change: "resumed",
  });
  return ok({
    status: "resumed",
    stripe_subscription_id: rows[0].stripe_subscription_id,
  });
}
