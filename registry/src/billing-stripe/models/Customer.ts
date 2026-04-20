/**
 * Customer — the billing-side counterpart to your User model.
 *
 * This keeps billing metadata (Stripe customer ID, tax info, default payment
 * method) separate from your User model so auth and billing concerns stay
 * decoupled. A Customer is created lazily on first checkout for a User.
 *
 * The Model ID is deliberately NOT the User ID — it's a Parcae-generated ID.
 * Look up by `user` when you want to find a user's billing record.
 */
import { Model } from "@parcae/model";

export class Customer extends Model {
  static type = "customer" as const;

  /**
   * Users read only their own customer record. No client-side writes — all
   * changes come through Stripe or Parcae server code.
   */
  static scope = {
    read: (ctx: any) =>
      ctx.user ? (qb: any) => qb.where("user", ctx.user.id) : null,
  };

  static indexes = ["user", "stripeCustomerId", "email"];

  /** Parcae User ID (foreign key to your auth-owned users table). */
  user: string = "";

  /** Stripe customer ID (cus_...). */
  stripeCustomerId: string = "";

  /** Email used for Stripe receipts (can differ from auth email). */
  email: string = "";

  /** Display name on Stripe side. */
  name: string = "";

  /** Phone number on Stripe side. */
  phone: string = "";

  /** ISO 4217 currency code for this customer's subscriptions. */
  currency: string = "usd";

  /** Default Stripe PaymentMethod ID. */
  defaultPaymentMethod: string = "";

  /** Balance on Stripe (in minor units). Negative = credit, positive = amount owed. */
  balance: number = 0;

  /** Billing address (kept as opaque JSONB — matches Stripe.Address). */
  address: Record<string, any> = {};

  /** Tax IDs (EU VAT, etc.) registered with Stripe. */
  taxIds: any[] = [];

  /** Customer-scoped metadata that round-trips to Stripe. */
  metadata: Record<string, string> = {};

  /** Whether the customer has been deleted in Stripe. */
  deleted: boolean = false;

  lastSyncedAt: Date | null = null;
}
