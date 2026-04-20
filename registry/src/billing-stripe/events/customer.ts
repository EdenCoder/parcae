import type Stripe from "stripe";
import { log } from "@parcae/backend";
import { upsertCustomer } from "../lib/sync";

export async function handleCustomerEvent(event: Stripe.Event): Promise<void> {
  const customer = event.data.object as
    | Stripe.Customer
    | Stripe.DeletedCustomer;

  switch (event.type) {
    case "customer.created":
    case "customer.updated":
    case "customer.deleted":
      await upsertCustomer(customer, null, `webhook:${event.type}`);
      log.info(`[billing] ${event.type} ${customer.id}`);
      break;

    default:
      log.info(`[billing] Unhandled customer event: ${event.type}`);
  }
}
