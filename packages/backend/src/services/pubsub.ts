/**
 * PubSub — Redis-backed cross-process events + distributed locking.
 *
 * Optional — if REDIS_URL not set, falls back to in-process EventEmitter.
 * Extracted from Dollhouse Studio's utilities/pubsub.ts (186 lines).
 */

import Client from "ioredis";
import AsyncLock from "async-lock";
import { Redlock } from "@sesamecare-oss/redlock";
import { EventEmitter } from "events";

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
    this.__events.setMaxListeners(0);
    this.building = config.url
      ? this.buildRedis(config.url)
      : Promise.resolve();
  }

  private async buildRedis(url: string): Promise<void> {
    const isTLS = url.startsWith("rediss://");
    const opts = isTLS ? { tls: { rejectUnauthorized: false } } : {};

    this.redisLock = new Client(url, opts);
    this.redisRead = new Client(url, opts);
    this.redisWrite = new Client(url, opts);

    this.redlock = new Redlock([this.redisLock], {
      retryCount: 25,
      retryDelay: 300,
      driftFactor: 0.01,
      retryJitter: 200,
    });

    await this.redisRead.subscribe("events");

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
      this.redisWrite.publish("events", JSON.stringify([event, ...args]));
    } else {
      // In-process fallback
      this.__events.emit(event, ...args);
    }
  }

  // ── Distributed Lock ─────────────────────────────────────────────────

  async lock(
    key: string,
    timeout = 5000,
    retry = 0,
  ): Promise<() => Promise<void>> {
    const MAX_RETRIES = 10;

    if (!this.redlock) {
      // In-process fallback — local lock only
      return new Promise<() => Promise<void>>((resolve) => {
        this.__lock.acquire(
          key,
          () =>
            new Promise<void>((sub) => {
              resolve(async () => sub());
            }),
          { timeout },
        );
      });
    }

    try {
      const lock = await this.redlock.acquire([key], timeout);

      return await new Promise<() => Promise<void>>((resolve) => {
        this.__lock.acquire(
          key,
          () =>
            new Promise<void>((sub) => {
              resolve(async () => {
                try {
                  await lock.release();
                } catch {}
                sub();
              });
            }),
          { timeout },
        );
      });
    } catch (e) {
      if (retry >= MAX_RETRIES) {
        throw new Error(
          `Failed to acquire lock for "${key}" after ${MAX_RETRIES} retries`,
        );
      }
      await new Promise<void>((r) => setTimeout(r, 50));
      return this.lock(key, timeout, retry + 1);
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.redisLock) await this.redisLock.quit();
    if (this.redisRead) await this.redisRead.quit();
    if (this.redisWrite) await this.redisWrite.quit();
    this.__events.removeAllListeners();
  }
}
