/**
 * SubscriptionItem — a line item on a Subscription.
 *
 * One row per Price on the subscription. Enables multi-item subscriptions
 * (seat-based + metered add-ons, bundles, etc.) and exposes the `quantity`
 * field for seat billing and the `meter` field for usage billing.
 */
import { Model } from "@parcae/model";
import { Subscription } from "./Subscription";
import { Price } from "./Price";

export class SubscriptionItem extends Model {
  static type = "subscription_item" as const;

  static scope = {
    read: (ctx: any) =>
      ctx.user ? (qb: any) => qb.where("user", ctx.user.id) : null,
  };

  static indexes = [
    "subscription",
    "stripeSubscriptionItemId",
    ["subscription", "price"],
  ];

  /** Denormalized user for scope filtering. */
  user: string = "";

  subscription!: Subscription;
  price!: Price;

  /** Stripe subscription item ID (si_...). */
  stripeSubscriptionItemId: string = "";

  /** Quantity (relevant for licensed/seat prices). */
  quantity: number = 1;

  /** Stripe Billing Meter ID (only for metered prices). */
  stripeMeterId: string = "";

  metadata: Record<string, string> = {};

  lastSyncedAt: Date | null = null;
}
