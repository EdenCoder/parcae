"use client";

/**
 * useBilling — convenience hook for calling billing endpoints.
 *
 * Wraps Parcae's useApi with typed methods for the routes installed by
 * @parcae/billing-stripe. Works with Parcae's socket or SSE transports.
 */
import { useCallback } from "react";
import { useApi } from "@parcae/sdk/react";

export interface CheckoutOptions {
  /** Parcae Price ID (preferred) — use Price.id */
  price?: string;
  /** Stripe price ID (price_...) — alternative */
  priceId?: string;
  quantity?: number;
  promotionCode?: string;
  successUrl?: string;
  cancelUrl?: string;
  metadata?: Record<string, string>;
}

export interface ChangePlanOptions {
  subscription: string;
  /** Parcae Price ID of the new plan */
  price: string;
  quantity?: number;
  prorationBehavior?: "create_prorations" | "none" | "always_invoice";
}

export interface CancelOptions {
  subscription: string;
  /** If true, cancel immediately instead of at period end */
  immediate?: boolean;
  feedback?: string;
  comment?: string;
}

export function useBilling() {
  const { post } = useApi();

  const checkout = useCallback(
    async (opts: CheckoutOptions): Promise<{ url: string; id: string }> => {
      return post("/v1/billing/checkout", opts);
    },
    [post],
  );

  const openCheckout = useCallback(
    async (opts: CheckoutOptions): Promise<void> => {
      const { url } = await checkout(opts);
      if (typeof window !== "undefined") window.location.href = url;
    },
    [checkout],
  );

  const portal = useCallback(
    async (returnUrl?: string): Promise<{ url: string }> => {
      return post("/v1/billing/portal", { returnUrl });
    },
    [post],
  );

  const openPortal = useCallback(
    async (returnUrl?: string): Promise<void> => {
      const { url } = await portal(returnUrl);
      if (typeof window !== "undefined") window.location.href = url;
    },
    [portal],
  );

  const cancel = useCallback(
    async (opts: CancelOptions): Promise<{ status: string }> => {
      return post("/v1/billing/subscription/cancel", opts);
    },
    [post],
  );

  const resume = useCallback(
    async (subscription: string): Promise<{ status: string }> => {
      return post("/v1/billing/subscription/resume", { subscription });
    },
    [post],
  );

  const changePlan = useCallback(
    async (opts: ChangePlanOptions): Promise<{ status: string }> => {
      return post("/v1/billing/subscription/change", opts);
    },
    [post],
  );

  const reportUsage = useCallback(
    async (opts: {
      event: string;
      quantity: number;
      timestamp?: number;
      idempotencyKey?: string;
      payload?: Record<string, any>;
    }): Promise<{ recorded: true }> => {
      return post("/v1/billing/usage", opts);
    },
    [post],
  );

  return {
    checkout,
    openCheckout,
    portal,
    openPortal,
    cancel,
    resume,
    changePlan,
    reportUsage,
  };
}
