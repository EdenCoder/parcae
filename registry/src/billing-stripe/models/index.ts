/**
 * BILLING_MODELS — spread into your `createApp({ models })` array.
 *
 * @example
 *   import { createApp } from "@parcae/backend";
 *   import { ALL_MODELS } from "@/models";
 *   import { BILLING_MODELS } from "@/models/billing";
 *
 *   const app = createApp({
 *     models: [...ALL_MODELS, ...BILLING_MODELS],
 *     // ...
 *   });
 */

export { Product } from "./Product";
export { Price } from "./Price";
export { Customer } from "./Customer";
export { Subscription } from "./Subscription";
export { SubscriptionItem } from "./SubscriptionItem";
export { Invoice } from "./Invoice";
export { PaymentMethod } from "./PaymentMethod";
export { Coupon } from "./Coupon";
export { PromotionCode } from "./PromotionCode";
export { Meter } from "./Meter";
export { UsageRecord } from "./UsageRecord";

export type { PriceInterval, PriceType, UsageType } from "./Price";
export type { SubscriptionStatus } from "./Subscription";
export type { InvoiceStatus } from "./Invoice";
export type { PaymentMethodType } from "./PaymentMethod";
export type { CouponDuration } from "./Coupon";
export type { MeterAggregation } from "./Meter";

import { Product } from "./Product";
import { Price } from "./Price";
import { Customer } from "./Customer";
import { Subscription } from "./Subscription";
import { SubscriptionItem } from "./SubscriptionItem";
import { Invoice } from "./Invoice";
import { PaymentMethod } from "./PaymentMethod";
import { Coupon } from "./Coupon";
import { PromotionCode } from "./PromotionCode";
import { Meter } from "./Meter";
import { UsageRecord } from "./UsageRecord";

export const BILLING_MODELS = [
  Product,
  Price,
  Customer,
  Subscription,
  SubscriptionItem,
  Invoice,
  PaymentMethod,
  Coupon,
  PromotionCode,
  Meter,
  UsageRecord,
];
