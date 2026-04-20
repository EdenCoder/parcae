/**
 * Push local Price changes to Stripe.
 *
 * Stripe Prices are immutable — `unit_amount` and `currency` can't be
 * changed after creation. For amount changes, create a new Price and
 * archive the old one (the reconcile flow will link them via lookup_key).
 *
 * This hook only handles:
 * - Creating a brand-new Stripe Price from a local Price row (no stripePriceId yet)
 * - Toggling `active` on an existing Price
 * - Updating `nickname`, `metadata`, `lookup_key` (mutable fields)
 */
import { hook } from "@parcae/backend";
import { log } from "@parcae/backend";
import { Price } from "../models/billing/Price";
import { Product } from "../models/billing/Product";
import { stripe } from "../lib/stripe";
import { isInSyncContext, runInSyncContext } from "../lib/sync-context";

hook.after(Price, "save", async ({ model }: any) => {
  if (isInSyncContext()) return;

  const price = model as any;
  const s = stripe();

  try {
    if (price.stripePriceId) {
      // Only mutable fields
      await s.prices.update(price.stripePriceId, {
        nickname: price.nickname || undefined,
        active: price.active,
        metadata: price.metadata ?? {},
        lookup_key: price.lookupKey || undefined,
      });
      log.info(`[billing] Price pushed → Stripe ${price.stripePriceId}`);
      return;
    }

    // New price — we need the Stripe product ID. Resolve via local Product.
    const localProduct = price.$product
      ? await (Product as any).where({ id: price.$product }).first()
      : null;

    if (!localProduct?.stripeProductId) {
      log.warn(
        `[billing] Cannot create Stripe Price: local Price ${price.id} has no product / stripeProductId`,
      );
      return;
    }

    const isRecurring = price.priceType === "recurring";
    const created = await s.prices.create({
      product: localProduct.stripeProductId,
      unit_amount: price.unitAmount,
      currency: price.currency,
      nickname: price.nickname || undefined,
      active: price.active,
      metadata: price.metadata ?? {},
      lookup_key: price.lookupKey || undefined,
      ...(isRecurring && {
        recurring: {
          interval: price.interval ?? "month",
          interval_count: price.intervalCount ?? 1,
          usage_type: price.usageType ?? "licensed",
          ...(price.usageType === "metered" &&
            price.aggregateUsage && {
              aggregate_usage: price.aggregateUsage,
            }),
          ...(price.trialPeriodDays > 0 && {
            trial_period_days: price.trialPeriodDays,
          }),
        },
      }),
    });

    await runInSyncContext("push:price", async () => {
      price.stripePriceId = created.id;
      price.lastSyncedAt = new Date();
      await price.save();
    });
    log.info(`[billing] Price created in Stripe: ${created.id}`);
  } catch (err: any) {
    log.error(
      `[billing] Failed to push Price ${price.id} to Stripe: ${err.message}`,
    );
  }
});
