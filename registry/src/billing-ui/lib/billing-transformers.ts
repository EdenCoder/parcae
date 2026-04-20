/**
 * Billing transformers — map Parcae billing Models to the `Plan` /
 * `CurrentPlan` shapes the presentational components expect.
 *
 * These mirror the types from billingsdk.com so the components stay
 * drop-in compatible. The local Price model carries enough info that we
 * can collapse multiple Prices (monthly + yearly) for the same Product
 * into a single Plan row with both `monthlyPrice` and `yearlyPrice`.
 */

// ─── Shared shapes (same structure as billingsdk) ────────────────────────────

export interface Plan {
  id: string;
  title: string;
  description: string;
  highlight?: boolean;
  type?: "monthly" | "yearly";
  currency?: string;
  monthlyPrice: string;
  yearlyPrice: string;
  buttonText: string;
  badge?: string;
  features: {
    name: string;
    icon: string;
    iconColor?: string;
  }[];
  /** @internal — attached so callers can resolve back to Parcae Model IDs. */
  _monthlyPriceId?: string;
  _yearlyPriceId?: string;
  _productId?: string;
}

export interface CurrentPlan {
  plan: Plan;
  type: "monthly" | "yearly" | "custom";
  price?: string;
  nextBillingDate: string;
  paymentMethod: string;
  status: "active" | "inactive" | "past_due" | "cancelled";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS: Record<string, string> = {
  usd: "$",
  eur: "€",
  gbp: "£",
  jpy: "¥",
  cad: "CA$",
  aud: "A$",
};

function symbolFor(code: string): string {
  return CURRENCY_SYMBOLS[code.toLowerCase()] ?? code.toUpperCase() + " ";
}

function formatAmount(minorUnits: number, currency: string): string {
  const code = currency.toLowerCase();
  // Zero-decimal currencies (JPY, etc.)
  const zeroDecimal = ["jpy", "krw", "vnd", "clp"];
  const value = zeroDecimal.includes(code)
    ? minorUnits
    : (minorUnits / 100).toFixed(minorUnits % 100 === 0 ? 0 : 2);
  return String(value);
}

// ─── Product + Prices → Plan ─────────────────────────────────────────────────

/**
 * Collapse one Product + its Prices into a single Plan.
 *
 * Picks the first monthly recurring price and first yearly recurring price.
 * One-time purchases are treated as monthly for display purposes.
 */
export function productToPlan(
  product: any,
  prices: any[],
  opts: { buttonText?: string; customBadge?: string } = {},
): Plan {
  const active = prices.filter((p) => p.active !== false);
  const monthly = active.find(
    (p) => p.interval === "month" && p.intervalCount === 1,
  );
  const yearly = active.find(
    (p) => p.interval === "year" && p.intervalCount === 1,
  );
  const fallback = active[0];

  const currencyCode = (monthly?.currency ??
    yearly?.currency ??
    fallback?.currency ??
    "usd") as string;

  const monthlyAmount = monthly
    ? formatAmount(monthly.unitAmount, currencyCode)
    : fallback
      ? formatAmount(fallback.unitAmount, currencyCode)
      : "0";

  const yearlyAmount = yearly
    ? formatAmount(yearly.unitAmount, currencyCode)
    : monthlyAmount;

  return {
    id: product.id,
    title: product.name ?? "",
    description: product.description ?? "",
    highlight: product.highlight ?? false,
    currency: symbolFor(currencyCode),
    monthlyPrice: monthlyAmount,
    yearlyPrice: yearlyAmount,
    buttonText: opts.buttonText ?? "Subscribe",
    badge: opts.customBadge ?? (product.highlight ? "Most popular" : undefined),
    features: (product.features ?? []).map((name: string) => ({
      name,
      icon: "check",
      iconColor: "text-emerald-500",
    })),
    _monthlyPriceId: monthly?.id,
    _yearlyPriceId: yearly?.id,
    _productId: product.id,
  };
}

/**
 * Collapse an array of Products + Prices into a Plan[] with consistent order.
 *
 * `prices` is the global Price array — this helper buckets them by product.
 */
export function productsToPlans(
  products: any[],
  prices: any[],
  opts: { buttonText?: string } = {},
): Plan[] {
  const byProduct = new Map<string, any[]>();
  for (const p of prices) {
    const productId = typeof p.product === "string" ? p.product : p.$product;
    if (!productId) continue;
    const list = byProduct.get(productId) ?? [];
    list.push(p);
    byProduct.set(productId, list);
  }

  return products.map((product) =>
    productToPlan(product, byProduct.get(product.id) ?? [], opts),
  );
}

// ─── Subscription → CurrentPlan ──────────────────────────────────────────────

/**
 * Convert a Subscription (+ resolved Plan) into the shape <SubscriptionCard />
 * expects. Status values are normalized to billingsdk's vocabulary.
 */
export function subscriptionToCurrentPlan(
  subscription: any,
  plan: Plan,
  opts: { paymentMethodLabel?: string } = {},
): CurrentPlan {
  const statusMap: Record<string, CurrentPlan["status"]> = {
    active: "active",
    trialing: "active",
    past_due: "past_due",
    canceled: "cancelled",
    incomplete: "inactive",
    incomplete_expired: "inactive",
    unpaid: "past_due",
    paused: "inactive",
  };

  const nextBillingDate = subscription.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—";

  // Infer monthly vs yearly from the bound Plan (the one visible to the user)
  // A real "custom" signal would require enterprise-plan metadata.
  const type: CurrentPlan["type"] =
    plan._yearlyPriceId && !plan._monthlyPriceId ? "yearly" : "monthly";

  return {
    plan,
    type,
    nextBillingDate,
    paymentMethod: opts.paymentMethodLabel ?? "Card on file",
    status: statusMap[subscription.status] ?? "inactive",
  };
}

// ─── Invoice → InvoiceItem ───────────────────────────────────────────────────

export interface InvoiceItem {
  id: string;
  date: string;
  amount: string;
  status: "paid" | "refunded" | "open" | "void";
  invoiceUrl?: string;
  description?: string;
}

export function invoiceToItem(invoice: any): InvoiceItem {
  const statusMap: Record<string, InvoiceItem["status"]> = {
    paid: "paid",
    open: "open",
    void: "void",
    uncollectible: "void",
    draft: "open",
  };

  const date = invoice.finalizedAt ?? invoice.createdAt ?? new Date();
  const dateStr = new Date(date).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return {
    id: invoice.id,
    date: dateStr,
    amount: `${symbolFor(invoice.currency)}${formatAmount(invoice.amountPaid || invoice.total, invoice.currency)}`,
    status: statusMap[invoice.status] ?? "open",
    invoiceUrl: invoice.hostedInvoiceUrl || invoice.invoicePdf || undefined,
    description: invoice.description || invoice.number || "Invoice",
  };
}
