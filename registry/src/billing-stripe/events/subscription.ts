import type Stripe from "stripe";
import { log } from "@parcae/backend";
import { upsertSubscription } from "../lib/sync";

export async function handleSubscriptionEvent(
  event: Stripe.Event,
): Promise<void> {
  const sub = event.data.object as Stripe.Subscription;

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
    case "customer.subscription.trial_will_end":
      await upsertSubscription(sub, `webhook:${event.type}`);
      log.info(`[billing] ${event.type} ${sub.id} (status=${sub.status})`);
      break;

    default:
      log.info(`[billing] Unhandled subscription event: ${event.type}`);
  }
}
