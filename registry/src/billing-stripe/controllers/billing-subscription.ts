/**
 * Subscription management endpoints.
 *
 *   POST /v1/billing/subscription/cancel  — cancel at period end (or immediately)
 *   POST /v1/billing/subscription/resume  — un-cancel a pending cancellation
 *   POST /v1/billing/subscription/change  — swap to a new Price (upgrade/downgrade)
 *
 * All operations call the Stripe API directly; webhooks will then sync the
 * updated subscription back to our local Subscription Model. In the meantime
 * we can optimistically update local state for snappy UI (but we skip that
 * here for simplicity — realtime diffs will arrive within a second).
 */
import { route, ok, notFound, badRequest } from "@parcae/backend";
import { stripe } from "../lib/stripe";
import { requireBillingAuth } from "../lib/auth";
import { Subscription } from "../models/billing/Subscription";
import { SubscriptionItem } from "../models/billing/SubscriptionItem";
import { Price } from "../models/billing/Price";

async function getOwnedSubscription(
  subscriptionId: string,
  userId: string,
  res: any,
): Promise<any> {
  const sub = await (Subscription as any)
    .where({ id: subscriptionId, user: userId })
    .first();
  if (!sub) {
    notFound(res, "Subscription not found");
    return null;
  }
  return sub;
}

// ─── POST /v1/billing/subscription/cancel ────────────────────────────────────

route.post(
  "/v1/billing/subscription/cancel",
  requireBillingAuth,
  async (req: any, res: any) => {
    const { subscription, immediate, feedback, comment } = req.body ?? {};
    if (!subscription) {
      badRequest(res, "Missing `subscription` (id)");
      return;
    }

    const sub = await getOwnedSubscription(subscription, req.userId, res);
    if (!sub) return;

    const s = stripe();
    if (immediate) {
      const canceled = await s.subscriptions.cancel(sub.stripeSubscriptionId, {
        cancellation_details: { comment, feedback },
      });
      ok(res, { status: canceled.status });
    } else {
      const updated = await s.subscriptions.update(sub.stripeSubscriptionId, {
        cancel_at_period_end: true,
        cancellation_details: { comment, feedback },
      });
      ok(res, {
        status: updated.status,
        cancelAt: (updated as any).cancel_at,
      });
    }
  },
);

// ─── POST /v1/billing/subscription/resume ────────────────────────────────────

route.post(
  "/v1/billing/subscription/resume",
  requireBillingAuth,
  async (req: any, res: any) => {
    const { subscription } = req.body ?? {};
    if (!subscription) {
      badRequest(res, "Missing `subscription` (id)");
      return;
    }

    const sub = await getOwnedSubscription(subscription, req.userId, res);
    if (!sub) return;

    const s = stripe();
    const updated = await s.subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });

    ok(res, { status: updated.status });
  },
);

// ─── POST /v1/billing/subscription/change ────────────────────────────────────

route.post(
  "/v1/billing/subscription/change",
  requireBillingAuth,
  async (req: any, res: any) => {
    const {
      subscription,
      price: newPriceId,
      quantity,
      prorationBehavior,
    } = req.body ?? {};

    if (!subscription || !newPriceId) {
      badRequest(res, "Missing `subscription` or `price`");
      return;
    }

    const sub = await getOwnedSubscription(subscription, req.userId, res);
    if (!sub) return;

    // Resolve new Price to stripePriceId
    const newPrice = await (Price as any).where({ id: newPriceId }).first();
    if (!newPrice) {
      notFound(res, "Price not found");
      return;
    }

    // Find the first SubscriptionItem (single-item subscription assumption)
    const item = await (SubscriptionItem as any)
      .where({ subscription: sub.id })
      .first();

    if (!item) {
      badRequest(res, "Subscription has no items to change");
      return;
    }

    const s = stripe();
    const updated = await s.subscriptions.update(sub.stripeSubscriptionId, {
      items: [
        {
          id: item.stripeSubscriptionItemId,
          price: newPrice.stripePriceId,
          quantity: quantity ?? item.quantity ?? 1,
        },
      ],
      proration_behavior: prorationBehavior ?? "create_prorations",
    });

    ok(res, { status: updated.status });
  },
);
