"use client";

/**
 * <CancelDialog /> — two-step cancellation flow with retention offer.
 *
 * Forked from billingsdk's cancel-subscription-dialog (MIT). Theme-context
 * dependency stripped — uses default shadcn tokens.
 */
import { useState, useEffect } from "react";
import { Button } from "@dollhousestudio/ui/components/button";
import { Badge } from "@dollhousestudio/ui/components/badge";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@dollhousestudio/ui/components/dialog";
import { X, Circle } from "lucide-react";
import { cn } from "@dollhousestudio/ui/lib/cn";
import type { Plan } from "../lib/billing-transformers";

export interface CancelDialogProps {
  title?: string;
  description?: string;
  plan: Plan;
  triggerButtonText?: string;
  warningTitle?: string;
  warningText?: string;
  keepButtonText?: string;
  continueButtonText?: string;
  finalTitle?: string;
  finalSubtitle?: string;
  finalWarningText?: string;
  goBackButtonText?: string;
  confirmButtonText?: string;
  onCancel: (planId: string) => Promise<void> | void;
  onKeepSubscription?: (planId: string) => Promise<void> | void;
  onDialogClose?: () => void;
  className?: string;
}

export function CancelDialog({
  title = "We're sorry to see you go",
  description = "Before you cancel, we hope you'll consider staying with us.",
  plan,
  triggerButtonText = "Cancel subscription",
  warningTitle,
  warningText,
  keepButtonText = "Keep subscription",
  continueButtonText = "Continue cancellation",
  finalTitle = "Final confirmation",
  finalSubtitle = "Are you sure you want to cancel?",
  finalWarningText = "This action cannot be undone and you'll lose access at period end.",
  goBackButtonText = "Go back",
  confirmButtonText = "Yes, cancel subscription",
  onCancel,
  onKeepSubscription,
  onDialogClose,
  className,
}: CancelDialogProps) {
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDialogClose = () => {
    setIsOpen(false);
    setShowConfirmation(false);
    setError(null);
    setIsLoading(false);
    onDialogClose?.();
  };

  const handleContinue = () => {
    setShowConfirmation(true);
    setError(null);
  };

  const handleKeep = async () => {
    try {
      setIsLoading(true);
      setError(null);
      if (onKeepSubscription) await onKeepSubscription(plan.id);
      handleDialogClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirm = async () => {
    try {
      setIsLoading(true);
      setError(null);
      await onCancel(plan.id);
      handleDialogClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to cancel subscription",
      );
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isOpen && e.key === "Escape") {
        e.preventDefault();
        handleDialogClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (open) setIsOpen(true);
        else handleDialogClose();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">{triggerButtonText}</Button>
      </DialogTrigger>
      <DialogContent
        className={cn(
          "flex w-[95%] flex-col overflow-hidden p-0 sm:max-w-[500px]",
          className,
        )}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogClose
          onClick={handleDialogClose}
          className="absolute right-4 top-4 z-10 rounded-sm opacity-70 transition-opacity hover:opacity-100"
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogClose>

        <div className="flex w-full flex-col gap-4 px-4 py-6">
          <div className="flex flex-col gap-2 text-center md:text-left">
            <h2 className="text-xl font-semibold md:text-2xl">{title}</h2>
            <p className="text-xs text-muted-foreground md:text-sm">
              {description}
            </p>
            {error && (
              <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
          </div>

          {!showConfirmation && (
            <div className="flex flex-col gap-4 rounded-lg bg-muted/50 p-4">
              <div className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                  <span className="text-lg font-semibold">
                    {plan.title} plan
                  </span>
                  <span className="text-sm text-muted-foreground">
                    Current subscription
                  </span>
                </div>
                <Badge variant="secondary">
                  {plan.currency}
                  {plan.monthlyPrice}/mo
                </Badge>
              </div>
              <div className="flex flex-col gap-2">
                {plan.features.slice(0, 4).map((f, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Circle className="h-2 w-2 fill-primary text-primary" />
                    <span className="text-sm text-muted-foreground">
                      {f.name}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!showConfirmation && (warningTitle || warningText) && (
            <div className="rounded-lg border bg-muted/30 p-4">
              {warningTitle && (
                <h3 className="mb-2 font-semibold">{warningTitle}</h3>
              )}
              {warningText && (
                <p className="text-sm text-muted-foreground">{warningText}</p>
              )}
            </div>
          )}

          {!showConfirmation ? (
            <div className="mt-auto flex flex-col gap-3 sm:flex-row">
              <Button
                className="flex-1"
                onClick={handleKeep}
                disabled={isLoading}
              >
                {isLoading ? "Processing…" : keepButtonText}
              </Button>
              <Button
                variant="destructive"
                className="flex-1"
                onClick={handleContinue}
                disabled={isLoading}
              >
                {continueButtonText}
              </Button>
            </div>
          ) : (
            <div className="mt-auto flex flex-col gap-4">
              <div className="rounded-lg bg-muted/50 p-4 text-center">
                <h3 className="mb-2 font-semibold">{finalTitle}</h3>
                <p className="mb-2 text-sm text-muted-foreground">
                  {finalSubtitle}
                </p>
                <p className="text-sm text-destructive">{finalWarningText}</p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setShowConfirmation(false)}
                  disabled={isLoading}
                >
                  {goBackButtonText}
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  onClick={handleConfirm}
                  disabled={isLoading}
                >
                  {isLoading ? "Cancelling…" : confirmButtonText}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
