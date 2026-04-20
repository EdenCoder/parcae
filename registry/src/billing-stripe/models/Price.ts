/**
 * Price — a specific price point for a Product.
 *
 * A Product can have many Prices (monthly, yearly, metered, tiered, etc.).
 * Amount is stored in the smallest currency unit (cents for USD) to match
 * Stripe's convention exactly.
 */
import { Model } from "@parcae/model";
import { Product } from "./Product";

export type PriceInterval = "day" | "week" | "month" | "year";
export type PriceType = "one_time" | "recurring";
export type UsageType = "licensed" | "metered";

export class Price extends Model {
  static type = "price" as const;

  static scope = {
    read: (ctx: any) => (ctx.user ? () => {} : null),
  };

  static indexes = [
    "product",
    "stripePriceId",
    "active",
    ["product", "active"],
  ];

  /** Stripe price ID (price_...). Set on first sync. */
  stripePriceId: string = "";

  /** The Product this price belongs to. */
  product!: Product;

  /** Display nickname (optional — Stripe exposes this as `nickname`). */
  nickname: string = "";

  /** Amount in minor units (e.g. cents). `null` if the price is tiered/custom. */
  unitAmount: number = 0;

  /** ISO 4217 currency code, lowercase — matches Stripe. */
  currency: string = "usd";

  /** One-time vs recurring. */
  priceType: PriceType = "recurring";

  /** Billing interval (only meaningful for recurring). */
  interval: PriceInterval = "month";

  /** How many intervals per billing cycle (1 month, 3 months, etc.). */
  intervalCount: number = 1;

  /** licensed (per-seat) or metered (usage-based). */
  usageType: UsageType = "licensed";

  /** For metered prices: how Stripe aggregates usage. */
  aggregateUsage: string = "";

  /** Trial duration in days (0 = no trial). */
  trialPeriodDays: number = 0;

  /** Lookup key — stable identifier consumers can reference instead of the generated ID. */
  lookupKey: string = "";

  /** Whether this price is available for new checkouts. */
  active: boolean = true;

  /** Arbitrary metadata that round-trips to Stripe. */
  metadata: Record<string, string> = {};

  /**
   * Raw tiers array for tiered pricing.
   *
   * Stored as JSONB. Each tier has `{ up_to, flat_amount?, unit_amount?,
   * flat_amount_decimal?, unit_amount_decimal? }`. See Stripe docs for
   * details — we don't model this as typed properties because we don't
   * query into it server-side.
   */
  tiers: any[] = [];

  /** Tiers mode: "graduated" or "volume" (only for tiered prices). */
  tiersMode: string = "";

  lastSyncedAt: Date | null = null;
}
