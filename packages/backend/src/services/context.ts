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

// ─── Global context (set by createApp at startup) ────────────────────────────

let _queue: QueueService | null = null;
let _pubsub: PubSub | null = null;

/** @internal — called by createApp() */
export function _setServices(queue: QueueService, pubsub: PubSub): void {
  _queue = queue;
  _pubsub = pubsub;
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
): Promise<boolean> {
  if (!_queue) {
    log.warn(
      `[parcae] enqueue("${name}"): no queue configured (REDIS_URL not set)`,
    );
    return false;
  }

  const queue = _queue.get();
  if (!queue) {
    log.warn(`enqueue("${name}"): queue not available`);
    return false;
  }

  if (options.jobId) {
    const job = await addJobIfNotExists(queue, name, data, {
      jobId: options.jobId.replace(/:/g, "."),
      removeOnComplete: options.removeOnComplete,
      removeOnFail: options.removeOnFail,
    });
    return job !== null;
  }

  await queue.add(name, data, {
    removeOnComplete: options.removeOnComplete ?? 100,
    removeOnFail: options.removeOnFail ?? 50,
  });
  return true;
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
    // No-op fallback
    return async () => {};
  }

  const result = await _pubsub.lock(key, ttl);
  if (!result) return async () => {};

  // PubSub.lock returns (() => void) | null — normalize to async
  if (typeof result === "function") {
    return async () => {
      result();
    };
  }

  return async () => {};
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
