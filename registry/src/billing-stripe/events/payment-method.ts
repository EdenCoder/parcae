import type Stripe from "stripe";
import { log } from "@parcae/backend";
import { upsertPaymentMethod } from "../lib/sync";
import { PaymentMethod } from "../models/billing/PaymentMethod";
import { runInSyncContext } from "../lib/sync-context";

export async function handlePaymentMethodEvent(
  event: Stripe.Event,
): Promise<void> {
  const pm = event.data.object as Stripe.PaymentMethod;

  switch (event.type) {
    case "payment_method.attached":
    case "payment_method.updated":
    case "payment_method.automatically_updated":
      await upsertPaymentMethod(pm, `webhook:${event.type}`);
      log.info(`[billing] ${event.type} ${pm.id}`);
      break;

    case "payment_method.detached":
      await runInSyncContext(`webhook:${event.type}`, async () => {
        const local = await (PaymentMethod as any)
          .where({ stripePaymentMethodId: pm.id })
          .first();
        if (local) {
          await local.remove();
        }
      });
      log.info(`[billing] ${event.type} ${pm.id}`);
      break;

    default:
      log.info(`[billing] Unhandled payment_method event: ${event.type}`);
  }
}
