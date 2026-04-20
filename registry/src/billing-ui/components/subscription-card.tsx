"use client";

/**
 * <SubscriptionCard /> — displays the user's current subscription and
 * exposes quick actions (manage in portal, update plan, cancel).
 *
 * Pass a `CurrentPlan` (from `subscriptionToCurrentPlan` or `useCurrentPlan`).
 */
import { Card, CardContent, CardHeader, CardTitle } from "@dollhousestudio/ui/components/card";
import { Badge } from "@dollhousestudio/ui/components/badge";
import { Separator } from "@dollhousestudio/ui/components/separator";
import { cn } from "@dollhousestudio/ui/lib/utils";
import { Calendar, CreditCard } from "lucide-react";
import type { CurrentPlan } from "../lib/billing-transformers";
import { CustomerPortalButton } from "./customer-portal-button";

export interface SubscriptionCardProps {
  currentPlan: CurrentPlan;
  className?: string;
  title?: string;
  description?: string;
  /** Slots for action buttons. */
  actions?: React.ReactNode;
}

const statusColor: Record<CurrentPlan["status"], string> = {
  active: "border-emerald-700/40 bg-emerald-600 text-emerald-50",
  inactive: "border-muted-foreground/30 bg-muted text-muted-foreground",
  past_due: "border-yellow-600/40 bg-yellow-600 text-yellow-50",
  cancelled: "border-red-700/40 bg-red-600 text-red-50",
};

const statusLabel: Record<CurrentPlan["status"], string> = {
  active: "Active",
  inactive: "Inactive",
  past_due: "Past due",
  cancelled: "Cancelled",
};

export function SubscriptionCard({
  currentPlan,
  className,
  title = "Current plan",
  description,
  actions,
}: SubscriptionCardProps) {
  const { plan, type, nextBillingDate, paymentMethod, status } = currentPlan;
  const price = type === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader className="space-y-1">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-lg font-medium">{title}</CardTitle>
            {description && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          <Badge className={statusColor[status]}>{statusLabel[status]}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold">{plan.title}</span>
          <span className="text-muted-foreground">
            {plan.currency}
            {price} / {type === "yearly" ? "year" : "month"}
          </span>
        </div>

        <Separator />

        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Calendar className="h-4 w-4" />
            <span>
              Next billing date:{" "}
              <span className="text-foreground">{nextBillingDate}</span>
            </span>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <CreditCard className="h-4 w-4" />
            <span>
              Payment method:{" "}
              <span className="text-foreground">{paymentMethod}</span>
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          {actions ?? <CustomerPortalButton />}
        </div>
      </CardContent>
    </Card>
  );
}
