/**
 * Push local Product changes to Stripe.
 *
 * Runs after every Product save. Skipped when inside a sync context
 * (i.e. the save originated from a webhook or reconcile job).
 */
import { hook } from "@parcae/backend";
import { log } from "@parcae/backend";
import { Product } from "../models/billing/Product";
import { stripe } from "../lib/stripe";
import { isInSyncContext, runInSyncContext } from "../lib/sync-context";

hook.after(Product, "save", async ({ model }: any) => {
  if (isInSyncContext()) return;

  const product = model as any;
  const s = stripe();

  try {
    const payload = {
      name: product.name,
      description: product.description || undefined,
      images: product.image ? [product.image] : undefined,
      active: product.active,
      metadata: product.metadata ?? {},
      // `features` is accepted by Stripe as a list of {name} objects
      features: (product.features ?? []).map((name: string) => ({ name })),
    };

    if (product.stripeProductId) {
      await s.products.update(product.stripeProductId, payload);
      log.info(`[billing] Product pushed → Stripe ${product.stripeProductId}`);
    } else {
      const created = await s.products.create(payload);
      // Write back the Stripe ID without re-firing this hook
      await runInSyncContext("push:product", async () => {
        product.stripeProductId = created.id;
        product.lastSyncedAt = new Date();
        await product.save();
      });
      log.info(`[billing] Product created in Stripe: ${created.id}`);
    }
  } catch (err: any) {
    log.error(
      `[billing] Failed to push Product ${product.id} to Stripe: ${err.message}`,
    );
  }
});

hook.after(Product, "remove", async ({ model }: any) => {
  if (isInSyncContext()) return;

  const product = model as any;
  if (!product.stripeProductId) return;

  try {
    // Stripe deletes products permanently only when no prices exist; otherwise
    // archive (active=false) is the convention.
    await stripe().products.update(product.stripeProductId, { active: false });
    log.info(
      `[billing] Product archived in Stripe: ${product.stripeProductId}`,
    );
  } catch (err: any) {
    log.error(`[billing] Failed to archive Product in Stripe: ${err.message}`);
  }
});
