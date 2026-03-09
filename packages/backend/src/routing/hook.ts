/**
 * @parcae/backend — hook
 *
 * Model lifecycle hooks. Mirrors the route API pattern.
 *
 * @example
 * ```typescript
 * hook.after(Post, "save", async ({ model, lock, enqueue }) => {
 *   const unlock = await lock(`post:index:${model.id}`);
 *   try {
 *     await model.refresh();
 *     // ...
 *   } finally {
 *     unlock();
 *   }
 * });
 *
 * hook.before(Post, "remove", async ({ model }) => {
 *   // cleanup before deletion
 * });
 *
 * // With options
 * hook.after(Post, "patch", handler, { async: true, priority: 200 });
 * ```
 */

import type { ModelConstructor } from "@parcae/model";

// ─── Types ───────────────────────────────────────────────────────────────────

export type HookTiming = "before" | "after";
export type HookAction = "save" | "patch" | "remove" | "create" | "update";

export type HookHandler = (ctx: HookContext) => Promise<void> | void;

export interface HookContext {
  /** The model instance being acted upon. */
  model: any;
  /** The action being performed. */
  action: HookAction;
  /** The raw request data (if applicable). */
  data?: Record<string, any>;
  /** Distributed lock function. */
  lock: (key: string, ttl?: number) => Promise<() => Promise<void>>;
  /** Enqueue a background job. Returns true if enqueued, false if deduped/skipped. */
  enqueue: (name: string, data: any, opts?: any) => Promise<boolean>;
  /** The authenticated user (if any). */
  user?: { id: string; [key: string]: any } | null;
}

export interface HookOptions {
  /** Whether the hook runs asynchronously (doesn't block the response). Default: false. */
  async?: boolean;
  /** Hook priority (lower = runs first). Default: 100. */
  priority?: number;
}

export interface HookEntry {
  modelType: string;
  modelClass: ModelConstructor;
  timing: HookTiming;
  actions: HookAction[];
  async: boolean;
  priority: number;
  handler: HookHandler;
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

// ─── Registration helpers ────────────────────────────────────────────────────

/**
 * Parse flexible args: (handler) or (handler, options)
 */
function parseArgs(args: any[]): {
  handler: HookHandler;
  options: HookOptions;
} {
  if (args.length === 1) return { handler: args[0], options: {} };

  const last = args[args.length - 1];
  if (typeof last === "object" && typeof last !== "function") {
    return { handler: args[0], options: last };
  }
  return { handler: args[0], options: {} };
}

function register(
  modelClass: ModelConstructor,
  timing: HookTiming,
  action: HookAction,
  ...args: any[]
): HookEntry {
  const { handler, options } = parseArgs(args);

  const entry: HookEntry = {
    modelType: modelClass.type,
    modelClass,
    timing,
    actions: [action],
    async: options.async ?? false,
    priority: options.priority ?? 100,
    handler,
  };

  registeredHooks.push(entry);
  return entry;
}

// ─── Hook API ────────────────────────────────────────────────────────────────

/**
 * Model lifecycle hooks — mirrors the route API pattern.
 *
 * ```typescript
 * hook.after(Post, "save", async ({ model }) => { ... });
 * hook.before(Post, "remove", async ({ model }) => { ... });
 * hook.after(Post, "patch", handler, { async: true, priority: 200 });
 * ```
 */
export const hook = {
  /**
   * Register an "after" hook — runs after the action completes.
   */
  after(
    modelClass: ModelConstructor,
    action: HookAction,
    ...args: any[]
  ): HookEntry {
    return register(modelClass, "after", action, ...args);
  },

  /**
   * Register a "before" hook — runs before the action.
   */
  before(
    modelClass: ModelConstructor,
    action: HookAction,
    ...args: any[]
  ): HookEntry {
    return register(modelClass, "before", action, ...args);
  },
};
