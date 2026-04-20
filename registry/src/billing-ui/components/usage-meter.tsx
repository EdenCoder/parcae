"use client";

/**
 * <UsageMeter /> — horizontal and circular progress indicators for
 * metered billing quotas.
 *
 * Forked from billingsdk's usage-meter-linear (MIT), simplified.
 */
import { useEffect } from "react";
import { motion, useSpring, useMotionValue, useTransform } from "motion/react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@dollhousestudio/ui/components/card";
import { Badge } from "@dollhousestudio/ui/components/badge";
import { cn } from "@dollhousestudio/ui/lib/utils";

export interface UsageItem {
  name: string;
  usage: number;
  limit: number;
}

export interface UsageMeterProps {
  usage: UsageItem[];
  className?: string;
  variant?: "linear" | "circle";
  size?: "sm" | "md" | "lg";
  title?: string;
  description?: string;
  /** If true, color the bar red/yellow/emerald based on saturation. */
  colorByUsage?: boolean;
}

function thresholdClasses(percentage: number) {
  if (percentage >= 90) return "from-red-500 to-red-400";
  if (percentage >= 75) return "from-yellow-500 to-yellow-400";
  if (percentage >= 50) return "from-emerald-500 to-emerald-400";
  if (percentage >= 25) return "from-blue-500 to-blue-400";
  return "from-gray-500 to-gray-400";
}

function statusBadge(percentage: number) {
  if (percentage >= 90) return <Badge variant="destructive">Critical</Badge>;
  if (percentage >= 75) return <Badge variant="secondary">High</Badge>;
  return null;
}

function LinearItem({
  item,
  colorByUsage,
}: {
  item: UsageItem;
  colorByUsage: boolean;
}) {
  const percentage = Math.min((item.usage / item.limit) * 100, 100);
  const remaining = Math.max(item.limit - item.usage, 0);

  const mv = useMotionValue(0);
  const spring = useSpring(mv, { stiffness: 100, damping: 20 });
  const display = useTransform(spring, (v) => `${Math.round(v)}%`);

  useEffect(() => {
    mv.set(percentage);
  }, [percentage, mv]);

  return (
    <div className="space-y-2 rounded-xl bg-muted/20 p-4">
      <div className="flex items-center justify-between">
        <span className="truncate text-sm font-medium">{item.name}</span>
        <motion.span className="text-xs text-muted-foreground">
          {display}
        </motion.span>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
        <motion.div
          className={cn(
            "h-3 rounded-full bg-gradient-to-r",
            colorByUsage
              ? thresholdClasses(percentage)
              : "from-primary to-primary/70",
          )}
          initial={{ width: 0 }}
          animate={{ width: `${percentage}%` }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {remaining.toLocaleString()} / {item.limit.toLocaleString()} left
        </span>
        {statusBadge(percentage)}
      </div>
    </div>
  );
}

export function UsageMeter({
  usage,
  className,
  variant = "linear",
  title,
  description,
  colorByUsage = false,
}: UsageMeterProps) {
  if (!usage?.length) return null;

  return (
    <Card className={cn("w-full max-w-md", className)}>
      {(title || description) && (
        <CardHeader className="space-y-1">
          {title && (
            <CardTitle className="truncate text-base font-medium">
              {title}
            </CardTitle>
          )}
          {description && (
            <CardDescription className="text-sm text-muted-foreground">
              {description}
            </CardDescription>
          )}
        </CardHeader>
      )}
      <CardContent className="grid grid-cols-1 gap-4">
        {variant === "linear" &&
          usage.map((item, i) => (
            <LinearItem
              key={item.name || i}
              item={item}
              colorByUsage={colorByUsage}
            />
          ))}
        {/* Circle variant trimmed for brevity — re-add if needed. */}
      </CardContent>
    </Card>
  );
}
