"use client";

/**
 * <PaymentMethodList /> — display saved payment methods.
 *
 * Mutations (add, remove, set default) go through the Stripe Customer
 * Portal. This component is read-only and points users at the portal
 * for any changes.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@dollhousestudio/ui/components/card";
import { Badge } from "@dollhousestudio/ui/components/badge";
import { cn } from "@dollhousestudio/ui/lib/utils";
import { CreditCard, Wallet } from "lucide-react";
import { CustomerPortalButton } from "./customer-portal-button";

export interface PaymentMethodListItem {
  id: string;
  paymentMethodType: string;
  brand?: string;
  last4: string;
  expMonth: number;
  expYear: number;
  wallet?: string;
  isDefault: boolean;
}

export interface PaymentMethodListProps {
  paymentMethods: PaymentMethodListItem[];
  className?: string;
  title?: string;
  loading?: boolean;
}

export function PaymentMethodList({
  paymentMethods,
  className,
  title = "Payment methods",
  loading,
}: PaymentMethodListProps) {
  return (
    <Card className={cn("w-full", className)}>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <CardTitle className="text-lg font-medium">{title}</CardTitle>
        <CustomerPortalButton size="sm" showIcon={false}>
          Add / edit
        </CustomerPortalButton>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        )}
        {!loading && paymentMethods.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No payment methods yet — add one via the portal.
          </div>
        )}
        {paymentMethods.map((pm) => {
          const brand = pm.brand
            ? pm.brand.charAt(0).toUpperCase() + pm.brand.slice(1)
            : pm.paymentMethodType;
          const Icon = pm.wallet ? Wallet : CreditCard;
          return (
            <div
              key={pm.id}
              className="flex items-center justify-between rounded-lg border p-3"
            >
              <div className="flex items-center gap-3">
                <div className="rounded-md border bg-background p-2">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {brand} •••• {pm.last4}
                    </span>
                    {pm.isDefault && (
                      <Badge variant="secondary" className="text-[10px]">
                        Default
                      </Badge>
                    )}
                  </div>
                  {pm.expMonth && pm.expYear && (
                    <span className="text-xs text-muted-foreground">
                      Expires {String(pm.expMonth).padStart(2, "0")}/
                      {String(pm.expYear).slice(-2)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
