import type Stripe from "stripe";
import { log } from "@parcae/backend";
import { upsertInvoice } from "../lib/sync";

export async function handleInvoiceEvent(event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;

  switch (event.type) {
    case "invoice.created":
    case "invoice.finalized":
    case "invoice.paid":
    case "invoice.payment_succeeded":
    case "invoice.payment_failed":
    case "invoice.voided":
    case "invoice.marked_uncollectible":
    case "invoice.upcoming":
      await upsertInvoice(invoice, `webhook:${event.type}`);
      log.info(
        `[billing] ${event.type} ${invoice.id} (${invoice.amount_paid}/${invoice.amount_due} ${invoice.currency})`,
      );
      break;

    default:
      log.info(`[billing] Unhandled invoice event: ${event.type}`);
  }
}
