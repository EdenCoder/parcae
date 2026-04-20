/**
 * Sync Context — Node AsyncLocalStorage flag that prevents webhook echo loops.
 *
 * Flow without this:
 *   Stripe webhook → events/product.ts → upsert Product → hook.after(Product, "save")
 *     → push to Stripe → Stripe fires another webhook → infinite loop.
 *
 * Flow with this:
 *   Webhook → runInSyncContext(async () => upsert Product)
 *     → hook.after(Product, "save") sees isInSyncContext() === true → no-op.
 *
 * Wrap every DB write that originates from a webhook (or from the reconcile
 * job) in `runInSyncContext`. The outbound push hooks check `isInSyncContext()`
 * and return early when true.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<{ source: string }>();

/**
 * Execute `fn` under a "we are currently syncing from Stripe" flag.
 * Outbound push hooks will short-circuit while this is active.
 */
export function runInSyncContext<T>(
  source: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    storage.run({ source }, () => {
      Promise.resolve(fn()).then(resolve, reject);
    });
  });
}

/**
 * True while any ancestor call frame is inside `runInSyncContext`.
 */
export function isInSyncContext(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * Return the sync source label ("webhook:product.created", "reconcile", etc.)
 * if we're inside a sync context — useful for debug logs.
 */
export function getSyncSource(): string | null {
  return storage.getStore()?.source ?? null;
}
