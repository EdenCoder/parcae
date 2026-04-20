import type Stripe from "stripe";
import { log } from "@parcae/backend";
import { handleProductEvent } from "./product";
import { handlePriceEvent } from "./price";
import { handleCustomerEvent } from "./customer";
import { handleSubscriptionEvent } from "./subscription";
import { handleInvoiceEvent } from "./invoice";
import { handleCheckoutEvent } from "./checkout";
import { handlePaymentMethodEvent } from "./payment-method";
import { upsertCoupon, upsertPromotionCode } from "../lib/sync";

/**
 * Dispatches a Stripe event to the appropriate handler based on prefix.
 *
 * Unknown events are logged but don't throw — Stripe will add new event
 * types over time and we want our server to keep running.
 */
export async function dispatchStripeEvent(event: Stripe.Event): Promise<void> {
  const prefix = event.type.split(".")[0];

  try {
    switch (prefix) {
      case "product":
        await handleProductEvent(event);
        break;

      case "price":
        await handlePriceEvent(event);
        break;

      case "customer":
        if (event.type.startsWith("customer.subscription.")) {
          await handleSubscriptionEvent(event);
        } else {
          await handleCustomerEvent(event);
        }
        break;

      case "invoice":
        await handleInvoiceEvent(event);
        break;

      case "checkout":
        await handleCheckoutEvent(event);
        break;

      case "payment_method":
        await handlePaymentMethodEvent(event);
        break;

      case "coupon":
        if (
          event.type === "coupon.created" ||
          event.type === "coupon.updated" ||
          event.type === "coupon.deleted"
        ) {
          await upsertCoupon(
            event.data.object as Stripe.Coupon,
            `webhook:${event.type}`,
          );
        }
        break;

      case "promotion_code":
        if (
          event.type === "promotion_code.created" ||
          event.type === "promotion_code.updated"
        ) {
          await upsertPromotionCode(
            event.data.object as Stripe.PromotionCode,
            `webhook:${event.type}`,
          );
        }
        break;

      default:
        log.info(
          `[billing] Unhandled event prefix: ${prefix} (${event.type})`,
        );
    }
  } catch (err: any) {
    log.error(
      `[billing] Event handler threw for ${event.type}: ${err.message}`,
      err,
    );
    throw err;
  }
}
