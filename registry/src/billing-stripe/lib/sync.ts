/**
 * Stripe → Parcae Model sync helpers.
 *
 * Each `upsert*` function:
 * 1. Finds the local Model by its Stripe ID
 * 2. Updates fields from the Stripe object (or creates a new row)
 * 3. Runs the whole operation inside `runInSyncContext` so outbound-push
 *    hooks skip (prevents webhook echo loops)
 *
 * Shared by webhook handlers AND the reconcile job.
 */
import type Stripe from "stripe";
import { Model } from "@parcae/model";
import { log } from "@parcae/backend";
import { Product } from "../models/billing/Product";
import { Price } from "../models/billing/Price";
import { Customer } from "../models/billing/Customer";
import { Subscription } from "../models/billing/Subscription";
import { SubscriptionItem } from "../models/billing/SubscriptionItem";
import { Invoice } from "../models/billing/Invoice";
import { PaymentMethod } from "../models/billing/PaymentMethod";
import { Coupon } from "../models/billing/Coupon";
import { PromotionCode } from "../models/billing/PromotionCode";
import { runInSyncContext } from "./sync-context";

const now = () => new Date();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tsToDate(ts: number | null | undefined): Date | null {
  return ts ? new Date(ts * 1000) : null;
}

async function upsertOrCreate<T extends typeof Model>(
  ModelClass: T,
  findBy: Record<string, any>,
  defaults: Record<string, any>,
): Promise<any> {
  const ModelAny = ModelClass as any;
  let instance = await ModelAny.where(findBy).first();
  if (!instance) {
    instance = ModelAny.create(defaults);
  } else {
    for (const [k, v] of Object.entries(defaults)) {
      (instance as any)[k] = v;
    }
  }
  await instance.save();
  return instance;
}

// ─── Products ────────────────────────────────────────────────────────────────

export async function upsertProduct(
  stripeProduct: Stripe.Product | Stripe.DeletedProduct,
  source = "sync:product",
): Promise<any> {
  return runInSyncContext(source, async () => {
    if ((stripeProduct as Stripe.DeletedProduct).deleted) {
      const existing = await (Product as any)
        .where({ stripeProductId: stripeProduct.id })
        .first();
      if (existing) {
        existing.active = false;
        existing.lastSyncedAt = now();
        await existing.save();
      }
      return existing;
    }

    const p = stripeProduct as Stripe.Product;
    return upsertOrCreate(
      Product,
      { stripeProductId: p.id },
      {
        stripeProductId: p.id,
        name: p.name ?? "",
        description: p.description ?? "",
        features: (p.marketing_features ?? []).map((f: any) => f.name),
        image: p.images?.[0] ?? "",
        active: p.active,
        metadata: p.metadata ?? {},
        lastSyncedAt: now(),
      },
    );
  });
}

// ─── Prices ──────────────────────────────────────────────────────────────────

export async function upsertPrice(
  stripePrice: Stripe.Price,
  source = "sync:price",
): Promise<any> {
  return runInSyncContext(source, async () => {
    const productId =
      typeof stripePrice.product === "string"
        ? stripePrice.product
        : stripePrice.product?.id;

    const localProduct = productId
      ? await (Product as any).where({ stripeProductId: productId }).first()
      : null;

    const recurring = stripePrice.recurring;
    return upsertOrCreate(
      Price,
      { stripePriceId: stripePrice.id },
      {
        stripePriceId: stripePrice.id,
        product: localProduct?.id ?? "",
        nickname: stripePrice.nickname ?? "",
        unitAmount: stripePrice.unit_amount ?? 0,
        currency: stripePrice.currency,
        priceType: stripePrice.type,
        interval: recurring?.interval ?? "month",
        intervalCount: recurring?.interval_count ?? 1,
        usageType: recurring?.usage_type ?? "licensed",
        // aggregate_usage removed in Stripe API v22; use Meter-linked Prices instead.
        aggregateUsage: (recurring as any)?.aggregate_usage ?? "",
        trialPeriodDays: recurring?.trial_period_days ?? 0,
        lookupKey: stripePrice.lookup_key ?? "",
        active: stripePrice.active,
        metadata: stripePrice.metadata ?? {},
        tiers: stripePrice.tiers ?? [],
        tiersMode: stripePrice.tiers_mode ?? "",
        lastSyncedAt: now(),
      },
    );
  });
}

// ─── Customers ───────────────────────────────────────────────────────────────

export async function upsertCustomer(
  stripeCustomer: Stripe.Customer | Stripe.DeletedCustomer,
  userId: string | null = null,
  source = "sync:customer",
): Promise<any> {
  return runInSyncContext(source, async () => {
    if ((stripeCustomer as any).deleted) {
      const existing = await (Customer as any)
        .where({ stripeCustomerId: stripeCustomer.id })
        .first();
      if (existing) {
        existing.deleted = true;
        existing.lastSyncedAt = now();
        await existing.save();
      }
      return existing;
    }

    const c = stripeCustomer as Stripe.Customer;

    // User linkage: metadata wins, then explicit param, then existing row
    const metaUser = c.metadata?.user ?? c.metadata?.userId ?? null;
    let existing = await (Customer as any)
      .where({ stripeCustomerId: c.id })
      .first();
    const resolvedUser = existing?.user || metaUser || userId || "";

    const defaults: Record<string, any> = {
      stripeCustomerId: c.id,
      user: resolvedUser,
      email: c.email ?? "",
      name: c.name ?? "",
      phone: c.phone ?? "",
      currency: (c.currency ?? "usd").toLowerCase(),
      defaultPaymentMethod:
        (typeof c.invoice_settings?.default_payment_method === "string"
          ? c.invoice_settings.default_payment_method
          : c.invoice_settings?.default_payment_method?.id) ?? "",
      balance: c.balance ?? 0,
      address: c.address ?? {},
      metadata: c.metadata ?? {},
      deleted: false,
      lastSyncedAt: now(),
    };

    return upsertOrCreate(Customer, { stripeCustomerId: c.id }, defaults);
  });
}

// ─── Subscriptions ───────────────────────────────────────────────────────────

export async function upsertSubscription(
  stripeSub: Stripe.Subscription,
  source = "sync:subscription",
): Promise<any> {
  return runInSyncContext(source, async () => {
    const customerId =
      typeof stripeSub.customer === "string"
        ? stripeSub.customer
        : stripeSub.customer.id;

    const customer = await (Customer as any)
      .where({ stripeCustomerId: customerId })
      .first();

    if (!customer) {
      log.warn(
        `[billing/sync] Subscription ${stripeSub.id} references unknown customer ${customerId}`,
      );
    }

    const s: any = stripeSub;
    const subscription = await upsertOrCreate(
      Subscription,
      { stripeSubscriptionId: stripeSub.id },
      {
        stripeSubscriptionId: stripeSub.id,
        customer: customer?.id ?? "",
        user: customer?.user ?? "",
        status: stripeSub.status,
        currentPeriodStart: tsToDate(s.current_period_start),
        currentPeriodEnd: tsToDate(s.current_period_end),
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end ?? false,
        cancelAt: tsToDate(stripeSub.cancel_at),
        canceledAt: tsToDate(stripeSub.canceled_at),
        stripeCreatedAt: tsToDate(stripeSub.created),
        trialStart: tsToDate(stripeSub.trial_start),
        trialEnd: tsToDate(stripeSub.trial_end),
        defaultPaymentMethod:
          (typeof stripeSub.default_payment_method === "string"
            ? stripeSub.default_payment_method
            : stripeSub.default_payment_method?.id) ?? "",
        collectionMethod: stripeSub.collection_method ?? "charge_automatically",
        latestInvoice:
          (typeof stripeSub.latest_invoice === "string"
            ? stripeSub.latest_invoice
            : stripeSub.latest_invoice?.id) ?? "",
        pendingUpdate: stripeSub.pending_update ?? {},
        cancellationDetails: stripeSub.cancellation_details ?? {},
        metadata: stripeSub.metadata ?? {},
        lastSyncedAt: now(),
      },
    );

    // Sync items
    for (const item of stripeSub.items?.data ?? []) {
      await upsertSubscriptionItem(item, subscription.id, source);
    }

    return subscription;
  });
}

export async function upsertSubscriptionItem(
  stripeItem: Stripe.SubscriptionItem,
  subscriptionId: string,
  source = "sync:subscription_item",
): Promise<any> {
  return runInSyncContext(source, async () => {
    const sub = await (Subscription as any)
      .where({ id: subscriptionId })
      .first();
    const priceId =
      typeof stripeItem.price === "object" ? stripeItem.price.id : "";
    const price = priceId
      ? await (Price as any).where({ stripePriceId: priceId }).first()
      : null;

    return upsertOrCreate(
      SubscriptionItem,
      { stripeSubscriptionItemId: stripeItem.id },
      {
        stripeSubscriptionItemId: stripeItem.id,
        subscription: subscriptionId,
        price: price?.id ?? "",
        user: sub?.user ?? "",
        quantity: stripeItem.quantity ?? 1,
        stripeMeterId: (stripeItem as any).metered_subscription_item_id ?? "",
        metadata: stripeItem.metadata ?? {},
        lastSyncedAt: now(),
      },
    );
  });
}

// ─── Invoices ────────────────────────────────────────────────────────────────

export async function upsertInvoice(
  stripeInv: Stripe.Invoice,
  source = "sync:invoice",
): Promise<any> {
  return runInSyncContext(source, async () => {
    const customerId =
      typeof stripeInv.customer === "string"
        ? stripeInv.customer
        : stripeInv.customer?.id;

    const customer = customerId
      ? await (Customer as any).where({ stripeCustomerId: customerId }).first()
      : null;

    const s: any = stripeInv;
    return upsertOrCreate(
      Invoice,
      { stripeInvoiceId: stripeInv.id! },
      {
        stripeInvoiceId: stripeInv.id,
        customer: customer?.id ?? "",
        user: customer?.user ?? "",
        subscription:
          (typeof s.subscription === "string"
            ? s.subscription
            : s.subscription?.id) ?? "",
        number: stripeInv.number ?? "",
        status: (stripeInv.status ?? "draft") as any,
        amountDue: stripeInv.amount_due ?? 0,
        amountPaid: stripeInv.amount_paid ?? 0,
        amountRemaining: stripeInv.amount_remaining ?? 0,
        total: stripeInv.total ?? 0,
        subtotal: stripeInv.subtotal ?? 0,
        currency: stripeInv.currency,
        hostedInvoiceUrl: stripeInv.hosted_invoice_url ?? "",
        invoicePdf: stripeInv.invoice_pdf ?? "",
        finalizedAt: tsToDate(s.status_transitions?.finalized_at),
        paidAt: tsToDate(s.status_transitions?.paid_at),
        dueDate: tsToDate(stripeInv.due_date),
        periodStart: tsToDate(stripeInv.period_start),
        periodEnd: tsToDate(stripeInv.period_end),
        lines: stripeInv.lines?.data ?? [],
        description: stripeInv.description ?? "",
        metadata: stripeInv.metadata ?? {},
        lastSyncedAt: now(),
      },
    );
  });
}

// ─── Payment Methods ─────────────────────────────────────────────────────────

export async function upsertPaymentMethod(
  stripePm: Stripe.PaymentMethod,
  source = "sync:payment_method",
): Promise<any> {
  return runInSyncContext(source, async () => {
    const customerId =
      typeof stripePm.customer === "string"
        ? stripePm.customer
        : stripePm.customer?.id;

    const customer = customerId
      ? await (Customer as any).where({ stripeCustomerId: customerId }).first()
      : null;

    return upsertOrCreate(
      PaymentMethod,
      { stripePaymentMethodId: stripePm.id },
      {
        stripePaymentMethodId: stripePm.id,
        customer: customer?.id ?? "",
        user: customer?.user ?? "",
        paymentMethodType: stripePm.type,
        brand: stripePm.card?.brand ?? "",
        last4: stripePm.card?.last4 ?? "",
        expMonth: stripePm.card?.exp_month ?? 0,
        expYear: stripePm.card?.exp_year ?? 0,
        country: stripePm.card?.country ?? "",
        wallet: stripePm.card?.wallet?.type ?? "",
        isDefault: !!customer && customer.defaultPaymentMethod === stripePm.id,
        billingDetails: stripePm.billing_details ?? {},
        metadata: stripePm.metadata ?? {},
        lastSyncedAt: now(),
      },
    );
  });
}

// ─── Coupons ─────────────────────────────────────────────────────────────────

export async function upsertCoupon(
  stripeCoupon: Stripe.Coupon,
  source = "sync:coupon",
): Promise<any> {
  return runInSyncContext(source, async () => {
    return upsertOrCreate(
      Coupon,
      { stripeCouponId: stripeCoupon.id },
      {
        stripeCouponId: stripeCoupon.id,
        name: stripeCoupon.name ?? "",
        percentOff: stripeCoupon.percent_off ?? 0,
        amountOff: stripeCoupon.amount_off ?? 0,
        currency: (stripeCoupon.currency ?? "usd").toLowerCase(),
        duration: stripeCoupon.duration,
        durationInMonths: stripeCoupon.duration_in_months ?? 0,
        maxRedemptions: stripeCoupon.max_redemptions ?? 0,
        timesRedeemed: stripeCoupon.times_redeemed ?? 0,
        redeemBy: tsToDate(stripeCoupon.redeem_by),
        active: stripeCoupon.valid,
        appliesToProducts: (stripeCoupon.applies_to?.products ??
          []) as string[],
        metadata: stripeCoupon.metadata ?? {},
        lastSyncedAt: now(),
      },
    );
  });
}

// ─── Promotion Codes ─────────────────────────────────────────────────────────

export async function upsertPromotionCode(
  stripePromo: Stripe.PromotionCode,
  source = "sync:promotion_code",
): Promise<any> {
  return runInSyncContext(source, async () => {
    // In Stripe API v22+ the coupon moved under `promotion.coupon`.
    // Older API shapes expose it at top level.
    const promoCoupon =
      (stripePromo as any).promotion?.coupon ??
      (stripePromo as any).coupon ??
      null;
    const couponId =
      typeof promoCoupon === "string" ? promoCoupon : (promoCoupon?.id ?? "");
    const coupon = couponId
      ? await (Coupon as any).where({ stripeCouponId: couponId }).first()
      : null;

    return upsertOrCreate(
      PromotionCode,
      { stripePromotionCodeId: stripePromo.id },
      {
        stripePromotionCodeId: stripePromo.id,
        code: stripePromo.code ?? "",
        coupon: coupon?.id ?? "",
        active: stripePromo.active,
        maxRedemptions: stripePromo.max_redemptions ?? 0,
        timesRedeemed: stripePromo.times_redeemed ?? 0,
        expiresAt: tsToDate(stripePromo.expires_at),
        firstTimeTransaction:
          stripePromo.restrictions?.first_time_transaction ?? false,
        minimumAmount: stripePromo.restrictions?.minimum_amount ?? 0,
        minimumAmountCurrency: (
          stripePromo.restrictions?.minimum_amount_currency ?? "usd"
        ).toLowerCase(),
        restrictToCustomer:
          (typeof stripePromo.customer === "string"
            ? stripePromo.customer
            : stripePromo.customer?.id) ?? "",
        metadata: stripePromo.metadata ?? {},
        lastSyncedAt: now(),
      },
    );
  });
}
