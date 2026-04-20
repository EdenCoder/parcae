"use client";

/**
 * useCurrentPlan — load the authenticated user's active Subscription
 * together with its Plan/Product, ready to feed to <SubscriptionCard />.
 *
 * Assumes the billing-stripe Models are installed (Product/Price/Subscription).
 *
 * @example
 *   const { currentPlan, subscription, loading } = useCurrentPlan();
 *   return currentPlan ? <SubscriptionCard currentPlan={currentPlan} /> : null;
 */
import { useMemo } from "react";
import { useQuery } from "@parcae/sdk/react";
import {
  productToPlan,
  subscriptionToCurrentPlan,
  type CurrentPlan,
} from "../lib/billing-transformers";

// Consumers pass their Model classes in. This hook is provider-agnostic.
export interface UseCurrentPlanModels {
  Subscription: any;
  SubscriptionItem: any;
  Price: any;
  Product: any;
  PaymentMethod?: any;
}

export function useCurrentPlan(models: UseCurrentPlanModels): {
  currentPlan: CurrentPlan | null;
  subscription: any | null;
  loading: boolean;
} {
  const { Subscription, SubscriptionItem, Price, Product, PaymentMethod } =
    models;

  // Active sub for the current user. Excludes canceled + expired.
  const { items: activeSubs, loading: subLoading } = useQuery<any>(
    Subscription.whereIn("status", ["active", "trialing", "past_due"])
      .orderBy("createdAt", "desc")
      .limit(1),
  );
  const subscription: any = activeSubs?.[0] ?? null;

  const subId = subscription?.id ?? null;
  const { items: items = [] } = useQuery<any>(
    subId ? SubscriptionItem.where({ subscription: subId }) : null,
  );
  const primaryItem: any = items[0];

  const priceId = primaryItem?.$price ?? primaryItem?.price ?? null;
  const { items: priceItems } = useQuery<any>(
    priceId ? Price.where({ id: priceId }).limit(1) : null,
  );
  const price: any = priceItems?.[0] ?? null;

  const productId = price?.$product ?? price?.product ?? null;
  const { items: productItems } = useQuery<any>(
    productId ? Product.where({ id: productId }).limit(1) : null,
  );
  const product: any = productItems?.[0] ?? null;

  const { items: allPrices = [] } = useQuery<any>(
    productId ? Price.where({ product: productId }) : null,
  );

  // PaymentMethod is optional — for the "Visa •••• 4242" label
  const pmId = subscription?.defaultPaymentMethod ?? null;
  const { items: pms = [] } = useQuery<any>(
    pmId && PaymentMethod
      ? PaymentMethod.where({ stripePaymentMethodId: pmId }).limit(1)
      : null,
  );
  const pm: any = pms[0];

  const currentPlan = useMemo<CurrentPlan | null>(() => {
    if (!subscription || !product) return null;
    const plan = productToPlan(product, allPrices);
    const label = pm
      ? `${pm.brand?.charAt(0).toUpperCase() + pm.brand?.slice(1)} •••• ${pm.last4}`
      : "Card on file";
    return subscriptionToCurrentPlan(subscription, plan, {
      paymentMethodLabel: label,
    });
  }, [subscription, product, allPrices, pm]);

  return {
    currentPlan,
    subscription,
    loading: subLoading,
  };
}
