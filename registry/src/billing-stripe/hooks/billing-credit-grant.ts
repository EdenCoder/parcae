/**
 * Credit grant hook — STUB.
 *
 * Integration point for your token/credit ledger (e.g. DOL-354 Credit model).
 *
 * This file is intentionally a stub. Wire it up to your app's ledger when
 * you're ready to grant credits on successful invoice payment:
 *
 * @example
 *   // When an Invoice transitions to status === "paid":
 *   const product = await Product.where({ stripeProductId: lineItemProduct }).first();
 *   const grantAmount = parseInt(product?.metadata?.grant_credits ?? "0", 10);
 *   if (grantAmount > 0) {
 *     const credit = Credit.create({
 *       user: invoice.user,
 *       amount: grantAmount,
 *       kind: "paid",
 *       source: "invoice",
 *       targetType: "invoice",
 *       targetId: invoice.id,
 *       idempotencyKey: `invoice:${invoice.id}`,
 *     });
 *     await credit.save();
 *   }
 *
 * Product.metadata.grant_credits is a convention — set it on a Stripe
 * Product ("grant_credits": "1000") to control how much this product grants.
 */
import { hook } from "@parcae/backend";
import { log } from "@parcae/backend";
import { Invoice } from "../models/billing/Invoice";

hook.after(Invoice, "save", async ({ model }: any) => {
  const invoice = model as any;
  if (invoice.status !== "paid" || !invoice.paidAt) return;

  // TODO(DOL-354): Grant credits from invoice.lines for token-pack products.
  log.info(
    `[billing] Invoice ${invoice.id} paid (user=${invoice.user}, amount=${invoice.amountPaid}). ` +
      `Credit ledger integration is stubbed — wire up in apps/*/hooks/billing-credit-grant.ts.`,
  );
});
