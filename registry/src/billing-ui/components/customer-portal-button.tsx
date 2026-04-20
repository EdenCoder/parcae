"use client";

/**
 * <CustomerPortalButton /> — opens the Stripe Customer Portal.
 *
 * Delegates most billing UX (card management, invoices, cancellation) to
 * Stripe's hosted portal so you don't have to build it.
 */
import { useState } from "react";
import { Button } from "@dollhousestudio/ui/components/button";
import { Loader2, ExternalLink } from "lucide-react";
import { useBilling } from "../hooks/use-billing";

export interface CustomerPortalButtonProps {
  returnUrl?: string;
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
  /** If false, show label without the external-link icon. */
  showIcon?: boolean;
  disabled?: boolean;
}

export function CustomerPortalButton({
  returnUrl,
  children = "Manage billing",
  className,
  variant = "outline",
  size = "default",
  showIcon = true,
  disabled,
}: CustomerPortalButtonProps) {
  const { openPortal } = useBilling();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    try {
      await openPortal(returnUrl);
    } catch (err) {
      console.error("[billing] Portal failed:", err);
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
      {pending ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : showIcon ? (
        <ExternalLink className="mr-2 h-4 w-4" />
      ) : null}
      {children}
    </Button>
  );
}
