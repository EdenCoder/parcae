/**
 * Coupon — a discount rule that can be applied to subscriptions/invoices.
 *
 * Coupons are referenced by PromotionCode (the public-facing, redeemable
 * string) or directly attached to a Customer. Stripe's model treats Coupon
 * as the discount mechanic and PromotionCode as the redemption handle.
 */
import { Model } from "@parcae/model";

export type CouponDuration = "once" | "repeating" | "forever";

export class Coupon extends Model {
  static type = "coupon" as const;

  static scope = {
    read: (ctx: any) => (ctx.user ? () => {} : null),
  };

  static indexes = ["stripeCouponId", "active"];

  /** Stripe coupon ID (often matches a human-readable slug like "SUMMER20"). */
  stripeCouponId: string = "";

  /** Display name. */
  name: string = "";

  /** Percent off (0-100). Zero when using `amountOff`. */
  percentOff: number = 0;

  /** Flat amount off in minor units. Zero when using `percentOff`. */
  amountOff: number = 0;

  /** ISO 4217 currency (only meaningful for `amountOff`). */
  currency: string = "usd";

  duration: CouponDuration = "once";

  /** Only for `duration: "repeating"`: how many months the discount applies. */
  durationInMonths: number = 0;

  /** Max total redemptions (0 = unlimited). */
  maxRedemptions: number = 0;

  /** Current redemption count (Stripe-maintained). */
  timesRedeemed: number = 0;

  /** Expiration timestamp (null = never expires). */
  redeemBy: Date | null = null;

  /** Whether the coupon is still available. Mirrors Stripe `valid`. */
  active: boolean = true;

  /** Specific Product IDs this coupon applies to (empty = all products). */
  appliesToProducts: string[] = [];

  metadata: Record<string, string> = {};

  lastSyncedAt: Date | null = null;
}
