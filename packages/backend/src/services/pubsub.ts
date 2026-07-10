/**
 * PubSub — Redis-backed cross-process events + distributed locking.
 *
 * Optional — if REDIS_URL not set, falls back to in-process EventEmitter.
 * Extracted from Dollhouse Studio's utilities/pubsub.ts (186 lines).
 */

import Client from "ioredis";
import AsyncLock from "async-lock";
import { Redlock } from "@sesamecare-oss/redlock";
// Pure-userland EventEmitter. Using `eventemitter3` instead of Node's
// built-in `events` module sidesteps an esbuild/tsx CJS-interop bug that
// mangles `import { EventEmitter } from "events"` into a broken
// `import_events.EventEmitter` namespace reference at runtime in some
// consumer setups.
import EventEmitter from "eventemitter3";
import { log } from "../logger";

// Namespaced Redis channel so multiple apps sharing one Redis
// instance don't cross-contaminate each other's pub/sub traffic.
const REDIS_CHANNEL = "parcae:events";

export interface PubSubConfig {
  /** Redis URL. If not provided, falls back to in-process events only. */
  url?: string;
}

export class PubSub {
  private __lock = new AsyncLock();
  private __events = new EventEmitter();
  private redlock: Redlock | null = null;
  private redisLock: Client | null = null;
  private redisRead: Client | null = null;
  private redisWrite: Client | null = null;

  public building: Promise<void>;

  constructor(config: PubSubConfig = {}) {
    this.building = config.url
      ? this.buildRedis(config.url)
      : Promise.resolve();
  }

  private async buildRedis(url: string): Promise<void> {
    const isTLS = url.startsWith("rediss://");
    const opts = isTLS ? { tls: { rejectUnauthorized: false } } : {};

    log.info(`PubSub connecting to Redis (TLS=${isTLS})...`);
    const t0 = Date.now();

    this.redisLock = new Client(url, opts);
    this.redisRead = new Client(url, opts);
    this.redisWrite = new Client(url, opts);

    for (const [name, client] of [
      ["lock", this.redisLock],
      ["read", this.redisRead],
      ["write", this.redisWrite],
    ] as const) {
      (client as Client).on("connect", () =>
        log.info(`PubSub redis:${name} connected (${Date.now() - t0}ms)`),
      );
      (client as Client).on("error", (err) =>
        log.warn(`PubSub redis:${name} error: ${err.message}`),
      );
      (client as Client).on("ready", () =>
        log.info(`PubSub redis:${name} ready (${Date.now() - t0}ms)`),
      );
    }

    this.redlock = new Redlock([this.redisLock], {
      retryCount: 25,
      retryDelay: 300,
      driftFactor: 0.01,
      retryJitter: 200,
    });

    log.info("PubSub subscribing to events channel...");
    await this.redisRead.subscribe(REDIS_CHANNEL);
    log.info(`PubSub subscribed (${Date.now() - t0}ms)`);

    this.redisRead.on("message", (_channel: string, message: string) => {
      try {
        const parsed = JSON.parse(message);
        this.__events.emit(parsed[0], ...parsed.slice(1));
      } catch {}
    });
  }

  // ── Pub/Sub ──────────────────────────────────────────────────────────

  emit(event: string, ...args: any[]): void {
    if (this.redisWrite) {
      void this.redisWrite
        .publish(REDIS_CHANNEL, JSON.stringify([event, ...args]))
        .catch((err) => {
          log.error(`PubSub publish failed for "${event}":`, err);
        });
    } else {
      // In-process fallback
      this.__events.emit(event, ...args);
    }
  }

  on(event: string, handler: (...args: any[]) => void): () => void {
    this.__events.on(event, handler);
    return () => {
      this.__events.off(event, handler);
    };
  }

  // ── Distributed Lock ─────────────────────────────────────────────────

  async lock(
    key: string,
    timeout = 5000,
  ): Promise<() => Promise<void>> {
    const MAX_RETRIES = 10;

    // In-process fallback — local lock only.
    //
    // AsyncLock.acquire(key, executor, { timeout }) returns a Promise
    // that *rejects* if the queue-wait timer fires before the executor
    // runs. If we discard that promise (as the original code did), the
    // rejection becomes an unhandled rejection and — under Node's
    // default `--unhandled-rejections=throw` — kills the process. We
    // pipe the rejection into the outer Promise's `reject` so the
    // caller's `await lock(...)` throws cleanly and can be caught.
    if (!this.redlock) {
      return new Promise<() => Promise<void>>((resolve, reject) => {
        this.__lock
          .acquire(
            key,
            () =>
              new Promise<void>((sub) => {
                resolve(async () => sub());
              }),
            { timeout },
          )
          .catch(reject);
      });
    }

    // Redlock path with iterative retry.
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let redLock: Awaited<ReturnType<NonNullable<typeof this.redlock>["acquire"]>>;
      try {
        redLock = await this.redlock.acquire([key], timeout);
      } catch {
        if (attempt >= MAX_RETRIES) {
          throw new Error(
            `Failed to acquire lock for "${key}" after ${MAX_RETRIES} retries`,
          );
        }
        await new Promise<void>((r) => setTimeout(r, 50));
        continue;
      }

      return new Promise<() => Promise<void>>((resolve, reject) => {
        this.__lock
          .acquire(
            key,
            () =>
              new Promise<void>((sub) => {
                resolve(async () => {
                  try {
                    await redLock.release();
                  } catch {}
                  sub();
                });
              }),
            { timeout },
          )
          .catch(async (err) => {
            // In-process queue-wait timed out while we already held the
            // Redis lock. Release it eagerly so we don't leak the
            // distributed lock for its full TTL.
            try {
              await redLock.release();
            } catch {}
            reject(err);
          });
      });
    }

    // Unreachable — the loop above always returns or throws.
    throw new Error(`Failed to acquire lock for "${key}"`);
  }

  // ── Try-lock (non-blocking) ──────────────────────────────────────────

  /**
   * Attempt to acquire a single-shot lock without waiting. Returns `true`
   * if this caller won the key, `false` if someone else already holds it.
   *
   * Uses `SET NX EX` semantics — the key is auto-released when the TTL
   * elapses. Falls back to in-process state when no Redis is configured.
   */
  async tryLock(key: string, ttlMs: number): Promise<boolean> {
    if (this.redisWrite) {
      const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
      const result = await this.redisWrite.set(
        key,
        "1",
        "EX",
        ttlSeconds,
        "NX",
      );
      return result === "OK";
    }

    // In-process fallback.
    const now = Date.now();
    const existing = this.__tryLocks.get(key);
    if (existing && existing > now) return false;
    this.__tryLocks.set(key, now + ttlMs);
    if (this.__tryLocks.size > 1024) {
      for (const [k, exp] of this.__tryLocks) {
        if (exp <= now) this.__tryLocks.delete(k);
      }
    }
    return true;
  }

  private __tryLocks = new Map<string, number>();

  // ── Cleanup ──────────────────────────────────────────────────────────

  async close(): Promise<void> {
    const clients = Array.from(
      new Set(
        [this.redisLock, this.redisRead, this.redisWrite].filter(
          (client): client is Client => client !== null,
        ),
      ),
    );
    this.redisLock = null;
    this.redisRead = null;
    this.redisWrite = null;
    this.redlock = null;
    this.__events.removeAllListeners();
    this.__tryLocks.clear();

    const results = await Promise.allSettled(
      clients.map(async (client) => {
        try {
          await client.quit();
        } catch (err) {
          try {
            client.disconnect();
          } catch {}
          throw err;
        }
      }),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to close PubSub Redis clients");
    }
  }
}
