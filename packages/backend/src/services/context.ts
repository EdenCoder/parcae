import { AsyncLocalStorage } from "node:async_hooks";
import type { Job } from "bullmq";
import { log } from "../logger";
/**
 * @parcae/backend — Global service context
 *
 * Populated by createApp() at startup. Provides access to queue, pubsub,
 * and lock from anywhere in the application.
 *
 * @example
 * ```typescript
 * import { enqueue, lock } from "@parcae/backend";
 *
 * // Enqueue a job (deduped by jobId)
 * await enqueue("post:index", { postId: "abc" }, { jobId: "post:index:abc" });
 *
 * // Distributed lock
 * const unlock = await lock("resource:abc");
 * try { ... } finally { await unlock(); }
 * ```
 */

import type { QueueService } from "./queue";
import { addJobIfNotExists } from "./queue";
import type { PubSub } from "./pubsub";
import type { RefLoader } from "./ref-loader";
import type { RuntimeFlags } from "../config";

// ─── Request context (per-request user via AsyncLocalStorage) ────────────────

interface RequestContext {
  user: { id: string; [key: string]: any } | null;
  /**
   * Per-request batcher for `BackendAdapter.findById`. Created in
   * `app.ts`'s per-request middleware so every `post.user` /
   * `comment.author` ref access on the backend coalesces into a
   * single `WHERE id IN (...)` lookup per type per microtask. Absent
   * when no `app.start()`-installed middleware ran (background jobs,
   * tests instantiating BackendAdapter directly) — `findById` then
   * falls back to its direct per-id query. See `./ref-loader.ts`.
   */
  refLoader?: RefLoader | null;
}

const _requestContext = new AsyncLocalStorage<RequestContext>();

/** Run a callback with request context (user) available to all downstream code. */
export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => T,
): T {
  return _requestContext.run(ctx, fn);
}

/** Get the current request's user, if available. */
export function getRequestUser(): {
  id: string;
  [key: string]: any;
} | null {
  return _requestContext.getStore()?.user ?? null;
}

/**
 * Get the request-scoped `RefLoader`, if any. Returns `null` when the
 * call is outside an `app.start()`-installed request scope (jobs,
 * tests). Consumers should fall through to direct queries on null —
 * the loader exists for batching, not correctness.
 */
export function getRefLoader(): RefLoader | null {
  return _requestContext.getStore()?.refLoader ?? null;
}

// ─── Global context (set by createApp at startup) ────────────────────────────

let _queue: QueueService | null = null;
let _pubsub: PubSub | null = null;
let _io: any = null;
// Default: hooks run, server runs, jobs and crons do not. Mirrors
// `resolveRuntimeFlags` defaults so adapter callers see sensible behaviour
// if startup never ran (mainly: unit tests that instantiate BackendAdapter
// directly).
let _flags: RuntimeFlags = {
  server: true,
  hooks: true,
  jobs: false,
  crons: false,
};

/** @internal — called by createApp() */
export function _setServices(queue: QueueService, pubsub: PubSub): void {
  _queue = queue;
  _pubsub = pubsub;
}

/** @internal — called by createApp() after server creation */
export function _setIo(io: any): void {
  _io = io;
}

/** @internal — called by createApp() once flags are resolved. */
export function _setRuntimeFlags(flags: RuntimeFlags): void {
  _flags = flags;
}

/** @internal — clears app-owned globals after failed startup or shutdown. */
export function _clearServices(): void {
  _queue = null;
  _pubsub = null;
  _io = null;
  _flags = {
    server: true,
    hooks: true,
    jobs: false,
    crons: false,
  };
}

/**
 * Read the resolved per-process runtime flags.
 *
 * Returns the same object the framework consulted during startup. Useful
 * for code that needs to branch on `RUN_SERVER` / `RUN_HOOKS` / `RUN_JOBS`
 * outside of `app.ts` (e.g. the model adapter's hook dispatch).
 *
 * Defaults to `{ server: true, hooks: true, jobs: false }` if `createApp()`
 * hasn't run yet — keeps direct `BackendAdapter` instantiation in tests sane.
 */
export function getRuntimeFlags(): RuntimeFlags {
  return _flags;
}

// ─── enqueue() ───────────────────────────────────────────────────────────────

export interface EnqueueOptions {
  /** Unique job ID for deduplication. If a job with this ID is already queued/active, skip. */
  jobId?: string;
  /** Max completed jobs to keep. Default: 100 */
  removeOnComplete?: number | boolean;
  /** Max failed jobs to keep. Default: 50 */
  removeOnFail?: number | boolean;
}

/**
 * Enqueue a background job. Deduplicates by jobId if provided.
 *
 * Each job name maps to its own BullMQ queue (`${defaultName}:${name}`), so
 * workers can subscribe selectively (`RUN_JOBS=panel,image`) and external
 * consumers can pick up specific jobs without seeing unrelated work.
 *
 * ```typescript
 * import { enqueue } from "@parcae/backend";
 *
 * await enqueue("post:index", { postId: model.id });
 * await enqueue("post:index", { postId: model.id }, { jobId: `post:index:${model.id}` });
 * ```
 */
export async function enqueue(
  name: string,
  data: any,
  options: EnqueueOptions = {},
): Promise<Job | false | null> {
  if (!_queue) {
    log.warn(
      `[parcae] enqueue("${name}"): no queue configured (REDIS_URL not set)`,
    );
    return false;
  }

  // Route by job name into a dedicated queue. The bare `defaultName` queue
  // is reserved for transitional legacy traffic — never enqueue there.
  const queueName = _queue.queueNameFor(name);
  const queue = _queue.get(queueName);
  if (!queue) {
    log.warn(`enqueue("${name}"): queue not available`);
    return false;
  }

  if (options.jobId) {
    return await addJobIfNotExists(queue, name, data, {
      jobId: options.jobId.replace(/:/g, "."),
      removeOnComplete: options.removeOnComplete,
      removeOnFail: options.removeOnFail,
    });
  }

  return await queue.add(name, data, {
    removeOnComplete: options.removeOnComplete ?? 100,
    removeOnFail: options.removeOnFail ?? 50,
  });
}

// ─── lock() ──────────────────────────────────────────────────────────────────

/**
 * Acquire a distributed lock. Returns an unlock function.
 *
 * Uses Redis (Redlock) if available, falls back to in-process AsyncLock.
 *
 * ```typescript
 * import { lock } from "@parcae/backend";
 *
 * const unlock = await lock("resource:abc", 120000);
 * try {
 *   // exclusive access
 * } finally {
 *   await unlock();
 * }
 * ```
 */
export async function lock(
  key: string,
  ttl: number = 120000,
): Promise<() => Promise<void>> {
  if (!_pubsub) {
    throw new Error(
      `[parcae] lock("${key}"): services are not initialized; call app.start() first`,
    );
  }

  return _pubsub.lock(key, ttl);
}

// ─── getQueue() / getPubSub() — escape hatches ──────────────────────────────

/** Get the raw QueueService instance. */
export function getQueue(): QueueService | null {
  return _queue;
}

/** Get the raw PubSub instance. */
export function getPubSub(): PubSub | null {
  return _pubsub;
}

/** Get the Socket.IO server instance. */
export function getIo(): any {
  return _io;
}
