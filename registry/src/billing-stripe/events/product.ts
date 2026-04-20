/**
 * Stripe product.* event handlers.
 *
 * Invoked from the webhook controller. All sync happens inside
 * `runInSyncContext` (inside upsertProduct) so the outbound-push hook
 * short-circuits and doesn't re-emit.
 */
import type Stripe from "stripe";
import { log } from "@parcae/backend";
import { upsertProduct } from "../lib/sync";
import { Product } from "../models/billing/Product";
import { runInSyncContext } from "../lib/sync-context";

export async function handleProductEvent(event: Stripe.Event): Promise<void> {
  const product = event.data.object as Stripe.Product;

  switch (event.type) {
    case "product.created":
    case "product.updated":
      await upsertProduct(product, `webhook:${event.type}`);
      log.info(`[billing] ${event.type} ${product.id}`);
      break;

    case "product.deleted":
      await runInSyncContext(`webhook:${event.type}`, async () => {
        const local = await (Product as any)
          .where({ stripeProductId: product.id })
          .first();
        if (local) {
          local.active = false;
          local.lastSyncedAt = new Date();
          await local.save();
        }
      });
      log.info(`[billing] ${event.type} ${product.id}`);
      break;

    default:
      log.info(`[billing] Unhandled product event: ${event.type}`);
  }
}
