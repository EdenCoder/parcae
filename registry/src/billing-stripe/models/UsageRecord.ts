/**
 * UsageRecord — a single usage event reported against a Meter.
 *
 * Local record of what was reported to Stripe. Helpful for dashboards and
 * cross-checks with the reconcile job. Stripe is the authoritative source
 * for billable usage — this is a local mirror.
 */
import { Model } from "@parcae/model";
import { SubscriptionItem } from "./SubscriptionItem";

export class UsageRecord extends Model {
  static type = "usage_record" as const;

  static scope = {
    read: (ctx: any) =>
      ctx.user ? (qb: any) => qb.where("user", ctx.user.id) : null,
  };

  static indexes = [
    "user",
    "subscriptionItem",
    "meter",
    ["subscriptionItem", "timestamp"],
  ];

  user: string = "";
  subscriptionItem!: SubscriptionItem;

  /** The Meter this record was reported against (Meter.id). */
  meter: string = "";

  /** Quantity reported. */
  quantity: number = 0;

  /** When the usage occurred. */
  timestamp: Date = new Date();

  /** Idempotency key passed to Stripe. */
  idempotencyKey: string = "";

  /** How Stripe received it: "increment" (default) or "set". */
  action: string = "increment";

  /** Arbitrary metadata attached locally (not sent to Stripe). */
  metadata: Record<string, string> = {};
}
