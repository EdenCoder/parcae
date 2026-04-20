/**
 * Push local Subscription changes to Stripe.
 *
 * Subscriptions are primarily mutated via the dedicated controllers
 * (/v1/billing/subscription/*). This hook catches programmatic changes —
 * e.g. app code calling `sub.cancelAtPeriodEnd = true; await sub.save()` —
 * and mirrors them to Stripe.
 */
import { hook } from "@parcae/backend";
import { log } from "@parcae/backend";
import { Subscription } from "../models/billing/Subscription";
import { stripe } from "../lib/stripe";
import { isInSyncContext } from "../lib/sync-context";

hook.after(Subscription, "save", async ({ model }: any) => {
  if (isInSyncContext()) return;

  const sub = model as any;
  if (!sub.stripeSubscriptionId) return;

  const s = stripe();

  try {
    const payload: any = {
      metadata: sub.metadata ?? {},
      cancel_at_period_end: sub.cancelAtPeriodEnd,
    };

    if (sub.defaultPaymentMethod) {
      payload.default_payment_method = sub.defaultPaymentMethod;
    }

    if (sub.collectionMethod) {
      payload.collection_method = sub.collectionMethod;
    }

    await s.subscriptions.update(sub.stripeSubscriptionId, payload);
    log.info(
      `[billing] Subscription pushed → Stripe ${sub.stripeSubscriptionId}`,
    );
  } catch (err: any) {
    log.error(
      `[billing] Failed to push Subscription ${sub.id} to Stripe: ${err.message}`,
    );
  }
});
