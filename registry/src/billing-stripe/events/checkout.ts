import type Stripe from "stripe";
import { log } from "@parcae/backend";
import { stripe } from "../lib/stripe";
import { upsertCustomer, upsertSubscription, upsertInvoice } from "../lib/sync";

/**
 * Checkout sessions roll up multiple downstream objects: Customer created,
 * Subscription created (for recurring) or Invoice paid (for one-time). We
 * re-fetch each one so we have the fully expanded object, then upsert.
 */
export async function handleCheckoutEvent(event: Stripe.Event): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
  const client = stripe();

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      // Customer: embedded or by ID
      if (session.customer) {
        const id =
          typeof session.customer === "string"
            ? session.customer
            : session.customer.id;
        const customer = await client.customers.retrieve(id);
        const appUserId =
          session.metadata?.user ?? session.metadata?.userId ?? null;
        await upsertCustomer(
          customer as Stripe.Customer,
          appUserId,
          `webhook:${event.type}`,
        );
      }

      // Recurring: sync the created subscription
      if (session.subscription) {
        const subId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id;
        const sub = await client.subscriptions.retrieve(subId, {
          expand: ["items"],
        });
        await upsertSubscription(sub, `webhook:${event.type}`);
      }

      // One-time: sync the resulting invoice
      if (session.invoice) {
        const invId =
          typeof session.invoice === "string"
            ? session.invoice
            : session.invoice.id;
        if (invId) {
          const inv = await client.invoices.retrieve(invId);
          await upsertInvoice(inv, `webhook:${event.type}`);
        }
      }

      log.info(`[billing] ${event.type} session=${session.id}`);
      break;
    }

    case "checkout.session.async_payment_failed":
    case "checkout.session.expired":
      log.info(`[billing] ${event.type} session=${session.id}`);
      break;

    default:
      log.info(`[billing] Unhandled checkout event: ${event.type}`);
  }
}
