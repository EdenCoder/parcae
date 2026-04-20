/**
 * Meter — a Stripe Billing Meter for usage-based pricing.
 *
 * A Meter defines how raw usage events (e.g. "api_request") are aggregated
 * (sum, count, last_during_period) into billable quantities. Prices with
 * `usageType: "metered"` reference a Meter.
 *
 * Server-only — no client read scope.
 */
import { Model } from "@parcae/model";

export type MeterAggregation = "sum" | "count" | "last_during_period";

export class Meter extends Model {
  static type = "meter" as const;

  /** Server-only (no scope). */
  static scope = {};

  static indexes = ["stripeMeterId", "eventName"];

  /** Stripe meter ID (mtr_...). */
  stripeMeterId: string = "";

  /** Display name. */
  displayName: string = "";

  /** The event name clients send via POST /v1/billing/meter-events (e.g. "api_request"). */
  eventName: string = "";

  /** How usage is aggregated. */
  aggregation: MeterAggregation = "sum";

  /**
   * JSON path into the event payload to extract the quantity
   * (Stripe's `default_aggregation.formula`). Default pulls `value`.
   */
  quantityPayloadKey: string = "value";

  /** JSON path to extract the Stripe customer ID (default: `stripe_customer_id`). */
  customerPayloadKey: string = "stripe_customer_id";

  /** Mirrors stripe.Meter.status — "active" or "inactive". */
  status: string = "active";

  metadata: Record<string, string> = {};

  lastSyncedAt: Date | null = null;
}
