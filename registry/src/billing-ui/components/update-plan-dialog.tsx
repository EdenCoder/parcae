"use client";

/**
 * <UpdatePlanDialog /> — switch between subscription plans.
 *
 * Forked from billingsdk's update-plan-dialog (MIT). Theme-context
 * dependency stripped.
 */
import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@dollhousestudio/ui/components/dialog";
import { Button } from "@dollhousestudio/ui/components/button";
import { Badge } from "@dollhousestudio/ui/components/badge";
import { Label } from "@dollhousestudio/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@dollhousestudio/ui/components/radio-group";
import { Toggle } from "@dollhousestudio/ui/components/toggle";
import { cn } from "@dollhousestudio/ui/lib/utils";
import type { Plan } from "../lib/billing-transformers";

const easing = [0.4, 0, 0.2, 1] as const;

export interface UpdatePlanDialogProps {
  currentPlan: Plan;
  plans: Plan[];
  triggerText?: string;
  onPlanChange: (
    planId: string,
    interval: "monthly" | "yearly",
  ) => Promise<void> | void;
  className?: string;
  title?: string;
}

export function UpdatePlanDialog({
  currentPlan,
  plans,
  triggerText = "Update plan",
  onPlanChange,
  className,
  title = "Change plan",
}: UpdatePlanDialogProps) {
  const [isYearly, setIsYearly] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string | undefined>();
  const [isOpen, setIsOpen] = useState(false);

  const getPrice = useCallback(
    (plan: Plan) => (isYearly ? plan.yearlyPrice : plan.monthlyPrice),
    [isYearly],
  );

  const handlePlanToggle = useCallback((planId: string) => {
    setSelectedPlan((prev) => (prev === planId ? undefined : planId));
  }, []);

  const handleOpenChange = useCallback((open: boolean) => {
    setIsOpen(open);
    if (!open) setSelectedPlan(undefined);
  }, []);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>{triggerText}</Button>
      </DialogTrigger>
      <DialogContent
        className={cn(
          "flex max-h-[95vh] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-4 p-6 sm:max-h-[90vh]",
          className,
        )}
      >
        <DialogHeader className="flex flex-col gap-3 pb-2 sm:flex-row sm:items-center sm:justify-between">
          <DialogTitle className="text-lg font-semibold sm:text-xl">
            {title}
          </DialogTitle>
          <div className="flex items-center gap-2 text-sm">
            <Toggle
              size="sm"
              pressed={!isYearly}
              onPressedChange={(p) => setIsYearly(!p)}
            >
              Monthly
            </Toggle>
            <Toggle
              size="sm"
              pressed={isYearly}
              onPressedChange={(p) => setIsYearly(p)}
            >
              Yearly
            </Toggle>
          </div>
        </DialogHeader>

        <div className="-mx-6 min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6">
          {plans.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-center">
              <p className="text-sm text-muted-foreground">
                No plans available
              </p>
            </div>
          ) : (
            <RadioGroup value={selectedPlan} onValueChange={handlePlanToggle}>
              <div className="space-y-3 pb-2">
                {plans.map((plan, index) => (
                  <motion.div
                    key={plan.id}
                    layout
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      layout: { duration: 0.3, ease: easing },
                      opacity: {
                        delay: index * 0.05,
                        duration: 0.3,
                        ease: easing,
                      },
                      y: { delay: index * 0.05, duration: 0.3, ease: easing },
                    }}
                    onClick={() => handlePlanToggle(plan.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handlePlanToggle(plan.id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selectedPlan === plan.id}
                    className={cn(
                      "relative cursor-pointer overflow-hidden rounded-xl border transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selectedPlan === plan.id
                        ? "border-primary bg-gradient-to-br from-muted/60 to-muted/30 shadow-sm"
                        : "hover:border-primary/50",
                    )}
                  >
                    <motion.div layout="position" className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 flex-1 gap-3">
                          <RadioGroupItem
                            value={plan.id}
                            id={plan.id}
                            className="pointer-events-none mt-1 flex-shrink-0"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Label
                                htmlFor={plan.id}
                                className="cursor-pointer text-base font-medium"
                              >
                                {plan.title}
                              </Label>
                              {plan.badge && (
                                <Badge
                                  variant="secondary"
                                  className="h-auto px-2 py-0.5 text-xs"
                                >
                                  {plan.badge}
                                </Badge>
                              )}
                            </div>
                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                              {plan.description}
                            </p>
                            {plan.features.length > 0 && (
                              <div className="pt-3">
                                <div className="flex flex-wrap gap-2">
                                  {plan.features.map((f, i) => (
                                    <div
                                      key={i}
                                      className="flex items-center gap-2 rounded-lg border border-border/30 bg-muted/20 px-2 py-1"
                                    >
                                      <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                                      <span className="whitespace-nowrap text-xs leading-none text-muted-foreground">
                                        {f.name}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="min-w-[80px] flex-shrink-0 text-right">
                          <div className="text-xl font-semibold">
                            {plan.currency}
                            {getPrice(plan)}
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            /{isYearly ? "year" : "month"}
                          </div>
                        </div>
                      </div>
                    </motion.div>

                    <AnimatePresence initial={false}>
                      {selectedPlan === plan.id && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.25, ease: easing }}
                          className="overflow-hidden"
                        >
                          <div className="px-4 pb-4">
                            <Button
                              className="h-11 w-full"
                              disabled={selectedPlan === currentPlan.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                onPlanChange(
                                  plan.id,
                                  isYearly ? "yearly" : "monthly",
                                );
                                handleOpenChange(false);
                              }}
                            >
                              {selectedPlan === currentPlan.id
                                ? "Current plan"
                                : isYearly
                                  ? "Switch to yearly"
                                  : "Switch to monthly"}
                            </Button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                ))}
              </div>
            </RadioGroup>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
