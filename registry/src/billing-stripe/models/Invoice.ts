/**
 * Invoice — a billing record from Stripe.
 *
 * Primary driver for the "invoice history" UI and downstream features like
 * credit grants on `invoice.paid`. Never written client-side.
 */
import { Model } from "@parcae/model";
import { Customer } from "./Customer";

export type InvoiceStatus =
  | "draft"
  | "open"
  | "paid"
  | "uncollectible"
  | "void";

export class Invoice extends Model {
  static type = "invoice" as const;

  static scope = {
    read: (ctx: any) =>
      ctx.user ? (qb: any) => qb.where("user", ctx.user.id) : null,
  };

  static indexes = [
    "user",
    "customer",
    "subscription",
    "stripeInvoiceId",
    "status",
    ["user", "status"],
  ];

  user: string = "";
  customer!: Customer;

  /** Source Subscription ID (empty for one-time charges). */
  subscription: string = "";

  /** Stripe invoice ID (in_...). */
  stripeInvoiceId: string = "";

  /** Human-readable invoice number assigned by Stripe. */
  number: string = "";

  status: InvoiceStatus = "draft";

  /** Amount in minor units. */
  amountDue: number = 0;
  amountPaid: number = 0;
  amountRemaining: number = 0;

  /** Total in minor units (after discounts, including tax). */
  total: number = 0;

  /** Subtotal (before tax). */
  subtotal: number = 0;

  /** ISO 4217 currency, lowercase. */
  currency: string = "usd";

  /** Hosted invoice URL (Stripe-hosted payment page). */
  hostedInvoiceUrl: string = "";

  /** Direct PDF download URL. */
  invoicePdf: string = "";

  /** When the invoice was finalized (null for drafts). */
  finalizedAt: Date | null = null;

  /** When the invoice was paid (null if unpaid). */
  paidAt: Date | null = null;

  /** Due date (for send_invoice collection method). */
  dueDate: Date | null = null;

  /** Period covered by this invoice. */
  periodStart: Date | null = null;
  periodEnd: Date | null = null;

  /** Line items (opaque JSONB — use stripe.invoices.retrieve for detail). */
  lines: any[] = [];

  /** Description shown to the customer. */
  description: string = "";

  metadata: Record<string, string> = {};

  lastSyncedAt: Date | null = null;
}
