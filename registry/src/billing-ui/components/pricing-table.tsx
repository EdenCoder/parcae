"use client";

/**
 * <PricingTable /> — Parcae-wired pricing table.
 *
 * Forked from billingsdk's pricing-table-one (dodopayments/billingsdk,
 * MIT). Theming stripped to the project's default shadcn tokens. Plans
 * are fed live from `useQuery(Product.where({ active: true }))`.
 */
import { Check, Zap } from "lucide-react";
import { useState, useId } from "react";
import { motion, AnimatePresence } from "motion/react";
import { cva, type VariantProps } from "class-variance-authority";

import { Badge } from "@dollhousestudio/ui/components/badge";
import { Button } from "@dollhousestudio/ui/components/button";
import { Label } from "@dollhousestudio/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@dollhousestudio/ui/components/radio-group";
import { Separator } from "@dollhousestudio/ui/components/separator";
import { cn } from "@dollhousestudio/ui/lib/utils";

import type { Plan } from "../lib/billing-transformers";

const sectionVariants = cva("py-16 md:py-24", {
  variants: {
    size: {
      small: "py-6 md:py-12",
      medium: "py-10 md:py-20",
      large: "py-16 md:py-32",
    },
  },
  defaultVariants: { size: "medium" },
});

const cardVariants = cva(
  "flex w-full flex-col rounded-lg border text-left h-full transition-all duration-300 p-6",
  {
    variants: {
      highlight: {
        true: "bg-muted",
        false: "",
      },
    },
    defaultVariants: { highlight: false },
  },
);

export interface PricingTableProps extends VariantProps<
  typeof sectionVariants
> {
  plans: Plan[];
  title?: string;
  description?: string;
  className?: string;
  /** Called with the selected Plan — do your checkout there. */
  onPlanSelect?: (plan: Plan, interval: "monthly" | "yearly") => void;
  defaultInterval?: "monthly" | "yearly";
}

export function PricingTable({
  plans,
  title = "Pricing",
  description = "Transparent pricing with no hidden fees.",
  onPlanSelect,
  defaultInterval = "monthly",
  size,
  className,
}: PricingTableProps) {
  const [isAnnually, setIsAnnually] = useState(defaultInterval === "yearly");
  const uniqueId = useId();

  const yearlyDiscount = plans.length
    ? Math.max(
        ...plans.map((p) => {
          const m = parseFloat(p.monthlyPrice);
          const y = parseFloat(p.yearlyPrice);
          if (isNaN(m) || isNaN(y) || m === 0) return 0;
          return Math.round(((m * 12 - y) / (m * 12)) * 100);
        }),
      )
    : 0;

  return (
    <section className={cn(sectionVariants({ size }), className)}>
      <div className="container relative p-0 md:p-4">
        <div className="mx-auto flex max-w-7xl flex-col gap-6">
          <div className="flex flex-col gap-4">
            <h2 className="text-pretty font-bold text-4xl lg:text-5xl">
              {title}
            </h2>
          </div>

          <div className="flex flex-col justify-between gap-5 md:flex-row md:gap-10">
            <p className="max-w-3xl text-lg text-muted-foreground lg:text-xl">
              {description}
            </p>
            <div className="flex h-11 w-fit shrink-0 items-center rounded-md bg-muted p-1 text-lg">
              <RadioGroup
                defaultValue={isAnnually ? "annually" : "monthly"}
                className="h-full grid-cols-2"
                onValueChange={(v) => setIsAnnually(v === "annually")}
              >
                <div className="h-full rounded-md transition-all has-[button[data-state=checked]]:bg-background">
                  <RadioGroupItem
                    value="monthly"
                    id={`${uniqueId}-monthly`}
                    className="peer sr-only"
                  />
                  <Label
                    htmlFor={`${uniqueId}-monthly`}
                    className="flex h-full cursor-pointer items-center justify-center px-4 text-sm font-semibold text-muted-foreground transition-all peer-data-[state=checked]:text-primary hover:text-foreground"
                  >
                    Monthly
                  </Label>
                </div>
                <div className="h-full rounded-md transition-all has-[button[data-state=checked]]:bg-background">
                  <RadioGroupItem
                    value="annually"
                    id={`${uniqueId}-annually`}
                    className="peer sr-only"
                  />
                  <Label
                    htmlFor={`${uniqueId}-annually`}
                    className="flex h-full cursor-pointer items-center justify-center gap-1 px-4 text-sm font-semibold text-muted-foreground transition-all peer-data-[state=checked]:text-primary hover:text-foreground"
                  >
                    Yearly
                    {yearlyDiscount > 0 && (
                      <span className="ml-1 rounded border border-primary/20 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        Save {yearlyDiscount}%
                      </span>
                    )}
                  </Label>
                </div>
              </RadioGroup>
            </div>
          </div>

          <div className="flex w-full flex-col items-stretch gap-6 md:flex-row">
            {plans.map((plan, index) => (
              <motion.div
                key={plan.id}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3, delay: index * 0.1 }}
                className={cn(cardVariants({ highlight: plan.highlight }))}
              >
                <Badge className="mb-6 w-fit">{plan.title}</Badge>

                <AnimatePresence mode="wait">
                  <motion.div
                    key={isAnnually ? "year" : "month"}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    <span className="text-4xl font-medium">
                      {parseFloat(
                        isAnnually ? plan.yearlyPrice : plan.monthlyPrice,
                      ) >= 0 && <>{plan.currency}</>}
                      {isAnnually ? plan.yearlyPrice : plan.monthlyPrice}
                    </span>
                    <p className="text-muted-foreground">
                      per {isAnnually ? "year" : "month"}
                    </p>
                  </motion.div>
                </AnimatePresence>

                <Separator className="my-6" />

                <div className="flex h-full flex-col justify-between gap-10">
                  <ul className="space-y-4 text-muted-foreground">
                    {plan.features.map((feature, i) => (
                      <motion.li
                        key={i}
                        className="flex gap-3"
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.3, delay: i * 0.05 }}
                      >
                        <Check className="h-4 w-4 flex-none text-primary" />
                        <span>{feature.name}</span>
                      </motion.li>
                    ))}
                  </ul>

                  <Button
                    onClick={() =>
                      onPlanSelect?.(plan, isAnnually ? "yearly" : "monthly")
                    }
                    aria-label={`Select ${plan.title}`}
                  >
                    {plan.highlight && <Zap className="mr-1 h-4 w-4" />}
                    {plan.buttonText}
                  </Button>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
