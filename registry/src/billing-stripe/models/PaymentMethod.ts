/**
 * PaymentMethod — a saved payment instrument for a Customer.
 *
 * We store only the non-sensitive bits (brand, last4, exp) — PCI data lives
 * on Stripe. Card updates/deletions go through the Stripe Billing Portal.
 */
import { Model } from "@parcae/model";
import { Customer } from "./Customer";

export type PaymentMethodType =
  | "card"
  | "link"
  | "us_bank_account"
  | "sepa_debit"
  | "au_becs_debit"
  | "bacs_debit"
  | "affirm"
  | "klarna"
  | "afterpay_clearpay"
  | "cashapp";

export class PaymentMethod extends Model {
  static type = "payment_method" as const;

  static scope = {
    read: (ctx: any) =>
      ctx.user ? (qb: any) => qb.where("user", ctx.user.id) : null,
  };

  static indexes = [
    "user",
    "customer",
    "stripePaymentMethodId",
    ["customer", "isDefault"],
  ];

  user: string = "";
  customer!: Customer;

  /** Stripe payment method ID (pm_...). */
  stripePaymentMethodId: string = "";

  paymentMethodType: PaymentMethodType = "card";

  /** Card brand (visa, mastercard, amex, ...). */
  brand: string = "";

  /** Last four digits. */
  last4: string = "";

  /** Card expiration month (1-12). */
  expMonth: number = 0;

  /** Card expiration year (YYYY). */
  expYear: number = 0;

  /** Issuing country code (US, GB, ...). */
  country: string = "";

  /** Wallet type (apple_pay, google_pay, "") if applicable. */
  wallet: string = "";

  /** Whether this is the customer's default payment method. */
  isDefault: boolean = false;

  /** Full billing details (opaque JSONB, matches stripe.BillingDetails). */
  billingDetails: Record<string, any> = {};

  metadata: Record<string, string> = {};

  lastSyncedAt: Date | null = null;
}
