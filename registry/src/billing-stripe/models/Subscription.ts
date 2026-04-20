/**
 * Subscription — a user's active or historical subscription.
 *
 * Line items live on SubscriptionItem (one per Price on the subscription) so
 * that multi-item subscriptions (e.g. seat-based + metered add-on) work
 * correctly. For the common single-item case you can derive the Price via
 * `SubscriptionItem.where({ subscription: sub.id }).first()`.
 *
 * Status values mirror Stripe exactly so no translation layer is required.
 */
import { Model } from "@parcae/model";
import { Customer } from "./Customer";

export type SubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export class Subscription extends Model {
  static type = "subscription" as const;

  static scope = {
    read: (ctx: any) =>
      ctx.user ? (qb: any) => qb.where("user", ctx.user.id) : null,
  };

  static indexes = [
    "user",
    "customer",
    "stripeSubscriptionId",
    "status",
    ["user", "status"],
  ];

  /** Denormalized User ID for scope filtering (matches Customer.user). */
  user: string = "";

  /** The billing Customer this subscription belongs to. */
  customer!: Customer;

  /** Stripe subscription ID (sub_...). */
  stripeSubscriptionId: string = "";

  /** Mirrors stripe.Subscription.status. */
  status: SubscriptionStatus = "incomplete";

  /** Start of the current billing period. */
  currentPeriodStart: Date | null = null;

  /** End of the current billing period (also next invoice date if active). */
  currentPeriodEnd: Date | null = null;

  /** If true, subscription cancels at period end (user initiated cancel). */
  cancelAtPeriodEnd: boolean = false;

  /** Explicit date the subscription was/will be canceled, if known. */
  cancelAt: Date | null = null;

  /** When the subscription was canceled (status transition to "canceled"). */
  canceledAt: Date | null = null;

  /** When the subscription was created in Stripe. */
  stripeCreatedAt: Date | null = null;

  /** Trial start/end dates (null if no trial). */
  trialStart: Date | null = null;
  trialEnd: Date | null = null;

  /** Stripe's default payment method for this subscription. */
  defaultPaymentMethod: string = "";

  /** Collection method: "charge_automatically" or "send_invoice". */
  collectionMethod: string = "charge_automatically";

  /** Latest invoice ID associated with this subscription. */
  latestInvoice: string = "";

  /** Pending update data (schedule changes, etc.) — opaque JSONB. */
  pendingUpdate: Record<string, any> = {};

  /** Cancellation details: reason, feedback, etc. */
  cancellationDetails: Record<string, any> = {};

  /** Metadata that round-trips to Stripe. */
  metadata: Record<string, string> = {};

  lastSyncedAt: Date | null = null;
}
