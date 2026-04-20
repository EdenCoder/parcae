/**
 * PromotionCode — the customer-facing string that redeems a Coupon.
 *
 * Codes like "BLACKFRIDAY25" that users type at checkout. Multiple
 * PromotionCodes can point at the same Coupon (e.g. channel-specific codes
 * for tracking).
 */
import { Model } from "@parcae/model";
import { Coupon } from "./Coupon";

export class PromotionCode extends Model {
  static type = "promotion_code" as const;

  static scope = {
    read: (ctx: any) => (ctx.user ? () => {} : null),
  };

  static indexes = ["stripePromotionCodeId", "code", "coupon", "active"];

  /** Stripe promotion code ID (promo_...). */
  stripePromotionCodeId: string = "";

  /** The redeemable code string (case-insensitive). */
  code: string = "";

  /** The Coupon this code grants. */
  coupon!: Coupon;

  /** Whether the code is redeemable today. */
  active: boolean = true;

  /** Maximum total redemptions across all customers (0 = unlimited). */
  maxRedemptions: number = 0;

  /** Current redemption count. */
  timesRedeemed: number = 0;

  /** Expiration timestamp. */
  expiresAt: Date | null = null;

  /** If true, code is only valid for first-time customers. */
  firstTimeTransaction: boolean = false;

  /** Minimum order amount in minor units. */
  minimumAmount: number = 0;

  /** ISO 4217 currency (for `minimumAmount`). */
  minimumAmountCurrency: string = "usd";

  /** Only redeemable by this specific Customer ID (empty = any customer). */
  restrictToCustomer: string = "";

  metadata: Record<string, string> = {};

  lastSyncedAt: Date | null = null;
}
