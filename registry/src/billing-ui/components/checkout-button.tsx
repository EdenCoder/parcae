"use client";

/**
 * <CheckoutButton /> — one-shot button that opens a Stripe Checkout session.
 *
 * Pass either a Parcae Price ID (`price`) or a Stripe price ID (`priceId`).
 * On click, it calls POST /v1/billing/checkout and redirects.
 */
import { useState } from "react";
import { Button } from "@dollhousestudio/ui/components/button";
import { Loader2 } from "lucide-react";
import { useBilling } from "../hooks/use-billing";

export interface CheckoutButtonProps {
  /** Parcae Price ID (preferred). */
  price?: string;
  /** Stripe price ID alternative. */
  priceId?: string;
  quantity?: number;
  successUrl?: string;
  cancelUrl?: string;
  promotionCode?: string;
  metadata?: Record<string, string>;
  children?: React.ReactNode;
  className?: string;
  variant?:
    | "default"
    | "destructive"
    | "outline"
    | "secondary"
    | "ghost"
    | "link";
  size?: "default" | "sm" | "lg" | "icon";
  disabled?: boolean;
}

export function CheckoutButton({
  price,
  priceId,
  quantity,
  successUrl,
  cancelUrl,
  promotionCode,
  metadata,
  children = "Subscribe",
  className,
  variant = "default",
  size = "default",
  disabled,
}: CheckoutButtonProps) {
  const { openCheckout } = useBilling();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    if (!price && !priceId) return;
    setPending(true);
    try {
      await openCheckout({
        price,
        priceId,
        quantity,
        successUrl,
        cancelUrl,
        promotionCode,
        metadata,
      });
    } catch (err) {
      console.error("[billing] Checkout failed:", err);
      setPending(false);
    }
  }

  return (
    <Button
      className={className}
      variant={variant}
      size={size}
      disabled={disabled || pending}
      onClick={handleClick}
    >
      {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {children}
    </Button>
  );
}
