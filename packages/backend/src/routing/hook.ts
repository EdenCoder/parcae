/**
 * @parcae/backend — hook()
 *
 * Model lifecycle hooks. Plain function API.
 *
 * @example
 * ```typescript
 * export default hook(Post, "after", ["save", "patch"], {
 *   async: true,
 *   priority: 200,
 *   handler: async ({ model, lock, enqueue }) => {
 *     const unlock = await lock(`post:index:${model.id}`);
 *     try {
 *       await model.refresh();
 *       // ...
 *     } finally {
 *       unlock();
 *     }
 *   },
 * });
 * ```
 */

import type { ModelConstructor } from "@parcae/model";

// ─── Types ───────────────────────────────────────────────────────────────────

export type HookTiming = "before" | "after";
export type HookAction = "save" | "patch" | "remove" | "create" | "update";

export interface HookContext {
  /** The model instance being acted upon. */
  model: any;
  /** The action being performed. */
  action: HookAction;
  /** The raw request data (if applicable). */
  data?: Record<string, any>;
  /** Distributed lock function. */
  lock: (key: string, ttl?: number) => Promise<() => Promise<void>>;
  /** Enqueue a background job. */
  enqueue: (name: string, data: any, opts?: any) => Promise<void>;
  /** The authenticated user (if any). */
  user?: { id: string; [key: string]: any } | null;
}

export interface HookOptions {
  /** Whether the hook runs asynchronously (doesn't block the response). Default: false. */
  async?: boolean;
  /** Hook priority (lower = runs first). Default: 100. */
  priority?: number;
  /** The hook handler function. */
  handler: (ctx: HookContext) => Promise<void> | void;
}

export interface HookEntry {
  modelType: string;
  modelClass: ModelConstructor;
  timing: HookTiming;
  actions: HookAction[];
  async: boolean;
  priority: number;
  handler: (ctx: HookContext) => Promise<void> | void;
}

// ─── Global Hook Registry ────────────────────────────────────────────────────

const registeredHooks: HookEntry[] = [];

export function getHooks(): HookEntry[] {
  return [...registeredHooks].sort((a, b) => a.priority - b.priority);
}

export function getHooksFor(
  modelType: string,
  timing: HookTiming,
  action: HookAction,
): HookEntry[] {
  return registeredHooks
    .filter(
      (h) =>
        h.modelType === modelType &&
        h.timing === timing &&
        h.actions.includes(action),
    )
    .sort((a, b) => a.priority - b.priority);
}

export function clearHooks(): void {
  registeredHooks.length = 0;
}

// ─── Hook registration ──────────────────────────────────────────────────────

/**
 * Register a model lifecycle hook.
 *
 * ```typescript
 * hook(Post, "after", ["save", "patch"], {
 *   handler: async ({ model }) => { ... }
 * });
 * ```
 */
export function hook(
  modelClass: ModelConstructor,
  timing: HookTiming,
  actions: HookAction[],
  options: HookOptions,
): HookEntry {
  const entry: HookEntry = {
    modelType: modelClass.type,
    modelClass,
    timing,
    actions,
    async: options.async ?? false,
    priority: options.priority ?? 100,
    handler: options.handler,
  };

  registeredHooks.push(entry);
  return entry;
}

export default hook;
