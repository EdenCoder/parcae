import type Stripe from "stripe";
import { log } from "@parcae/backend";
import { upsertPrice } from "../lib/sync";
import { Price } from "../models/billing/Price";
import { runInSyncContext } from "../lib/sync-context";

export async function handlePriceEvent(event: Stripe.Event): Promise<void> {
  const price = event.data.object as Stripe.Price;

  switch (event.type) {
    case "price.created":
    case "price.updated":
      await upsertPrice(price, `webhook:${event.type}`);
      log.info(`[billing] ${event.type} ${price.id}`);
      break;

    case "price.deleted":
      await runInSyncContext(`webhook:${event.type}`, async () => {
        const local = await (Price as any)
          .where({ stripePriceId: price.id })
          .first();
        if (local) {
          local.active = false;
          local.lastSyncedAt = new Date();
          await local.save();
        }
      });
      log.info(`[billing] ${event.type} ${price.id}`);
      break;

    default:
      log.info(`[billing] Unhandled price event: ${event.type}`);
  }
}
