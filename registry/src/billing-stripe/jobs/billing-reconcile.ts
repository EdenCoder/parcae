/**
 * billing:reconcile — daily safety-net sync.
 *
 * Walks all known Stripe customer/subscription/invoice/product/price IDs
 * and pulls their current state from Stripe. Covers webhook drops, network
 * hiccups, and bulk Dashboard edits that outran our webhook endpoint.
 *
 * Schedule this with your own cron / queue scheduler — e.g.:
 *
 *   await enqueue("billing:reconcile", {}, {
 *     repeat: { cron: "0 3 * * *" },  // 3am daily
 *     jobId: "billing:reconcile",     // dedupe
 *   });
 */
import { job } from "@parcae/backend";
import { log } from "@parcae/backend";
import { stripe } from "../lib/stripe";
import {
  upsertProduct,
  upsertPrice,
  upsertCustomer,
  upsertSubscription,
  upsertInvoice,
  upsertCoupon,
  upsertPromotionCode,
} from "../lib/sync";

async function reconcileProducts() {
  const s = stripe();
  let count = 0;
  for await (const p of s.products.list({ limit: 100 })) {
    await upsertProduct(p, "reconcile");
    count++;
  }
  return count;
}

async function reconcilePrices() {
  const s = stripe();
  let count = 0;
  for await (const p of s.prices.list({ limit: 100 })) {
    await upsertPrice(p, "reconcile");
    count++;
  }
  return count;
}

async function reconcileCoupons() {
  const s = stripe();
  let count = 0;
  for await (const c of s.coupons.list({ limit: 100 })) {
    await upsertCoupon(c, "reconcile");
    count++;
  }
  return count;
}

async function reconcilePromotionCodes() {
  const s = stripe();
  let count = 0;
  for await (const pc of s.promotionCodes.list({ limit: 100 })) {
    await upsertPromotionCode(pc, "reconcile");
    count++;
  }
  return count;
}

async function reconcileCustomersAndSubscriptions() {
  const s = stripe();
  let customerCount = 0;
  let subCount = 0;

  for await (const c of s.customers.list({ limit: 100 })) {
    await upsertCustomer(c, null, "reconcile");
    customerCount++;

    for await (const sub of s.subscriptions.list({
      customer: c.id,
      status: "all",
      limit: 100,
    })) {
      await upsertSubscription(sub, "reconcile");
      subCount++;
    }
  }

  return { customerCount, subCount };
}

async function reconcileInvoices() {
  const s = stripe();
  // Window: last 90 days. Tune as needed — older invoices rarely change.
  const since = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 90;
  let count = 0;
  for await (const inv of s.invoices.list({
    created: { gte: since },
    limit: 100,
  })) {
    await upsertInvoice(inv, "reconcile");
    count++;
  }
  return count;
}

job("billing:reconcile", async () => {
  log.info("[billing:reconcile] Starting");

  const products = await reconcileProducts();
  const prices = await reconcilePrices();
  const coupons = await reconcileCoupons();
  const promotionCodes = await reconcilePromotionCodes();
  const { customerCount, subCount } =
    await reconcileCustomersAndSubscriptions();
  const invoices = await reconcileInvoices();

  log.info(
    `[billing:reconcile] Done — products=${products}, prices=${prices}, ` +
      `coupons=${coupons}, promos=${promotionCodes}, customers=${customerCount}, ` +
      `subs=${subCount}, invoices=${invoices}`,
  );

  return {
    products,
    prices,
    coupons,
    promotionCodes,
    customers: customerCount,
    subscriptions: subCount,
    invoices,
  };
});
