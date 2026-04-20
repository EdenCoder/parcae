/**
 * Product — a billable item in the catalog.
 *
 * Synced bi-directionally with Stripe: admins can create products in either
 * the Stripe Dashboard or through Parcae (e.g. via an admin controller).
 * Webhooks keep the local copy in sync with Stripe; `hook.after(Product, "save")`
 * keeps Stripe in sync with local changes.
 *
 * Source of truth conflicts: Stripe wins on conflicts (webhooks are replayed
 * via the reconcile job as a safety net). The `stripeProductId` field is
 * populated the first time a local product is pushed to Stripe.
 */
import { Model } from "@parcae/model";

export class Product extends Model {
  static type = "product" as const;

  /** Any authenticated user can read the active catalog. Writes go through Stripe. */
  static scope = {
    read: (ctx: any) => (ctx.user ? () => {} : null),
  };

  static indexes = ["stripeProductId", "active", ["active", "updatedAt"]];

  /** Stripe product ID (prod_...). Set on first sync. */
  stripeProductId: string = "";

  /** Display name. */
  name: string = "";

  /** Long description (Markdown allowed). */
  description: string = "";

  /** Feature bullets shown in pricing tables. */
  features: string[] = [];

  /** Marketing image URL (Stripe stores up to 8 images — we keep the first). */
  image: string = "";

  /** Whether the product is available for purchase. Mirrors stripe.Product.active. */
  active: boolean = true;

  /** Arbitrary provider/app metadata (tax code, category, etc.). */
  metadata: Record<string, string> = {};

  /**
   * App-specific flags. These never round-trip to Stripe — useful for marking
   * a product as the "highlighted" option in a pricing table, or flagging
   * token-pack products for the credits grant hook.
   */
  highlight: boolean = false;

  /** When the product was last reconciled from Stripe. */
  lastSyncedAt: Date | null = null;
}
