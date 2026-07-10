/**
 * Regression tests for PubSub.lock() — in-process fallback path.
 *
 * History: prior to dollhouse DOL-890, when the in-process AsyncLock
 * queue-wait timer fired before the executor ran (i.e. the previous
 * holder was still busy), async-lock rejected the Promise returned by
 * its `.acquire(...)` call. PubSub.lock() discarded that Promise, so
 * the rejection became an unhandledRejection and — under Node's
 * default `--unhandled-rejections=throw` (Node 24+) — killed the
 * process. The fix wires that rejection into the outer lock() Promise
 * so `await lock(...)` throws cleanly and callers can catch.
 *
 * Redis path is exercised by `e2e-middleware.test.ts` and the larger
 * integration suite; here we only cover the in-process branch (no
 * `url`), which is what real-world single-instance dev installs and
 * the cross-process contention re-entry pattern both rely on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PubSub } from "../services/pubsub";
import { log } from "../logger";
import { _clearServices, lock } from "../services/context";

describe("PubSub.lock — in-process fallback", () => {
  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", captureUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", captureUnhandled);
  });

  it("acquires and releases a lock", async () => {
    const pubsub = new PubSub();
    const unlock = await pubsub.lock("alpha");
    await unlock();
    expect(unhandled).toHaveLength(0);
  });

  it("serializes concurrent acquires on the same key", async () => {
    const pubsub = new PubSub();
    const order: string[] = [];

    const first = (async () => {
      const unlock = await pubsub.lock("beta", 500);
      order.push("first:acquired");
      await new Promise((r) => setTimeout(r, 50));
      order.push("first:releasing");
      await unlock();
    })();

    // Yield so the first acquire wins the queue slot before the second
    // call enqueues itself behind it.
    await new Promise((r) => setTimeout(r, 5));

    const second = (async () => {
      const unlock = await pubsub.lock("beta", 500);
      order.push("second:acquired");
      await unlock();
    })();

    await Promise.all([first, second]);

    expect(order).toEqual([
      "first:acquired",
      "first:releasing",
      "second:acquired",
    ]);
    expect(unhandled).toHaveLength(0);
  });

  it("rejects (rather than crashing) when the queue-wait timer fires", async () => {
    // Regression for DOL-890. Hold the lock longer than the second
    // caller's timeout. Before the fix this produced an
    // unhandledRejection from async-lock and killed the process; now
    // the await on lock() must throw a normal Error that the caller
    // can catch.
    const pubsub = new PubSub();
    const firstUnlock = await pubsub.lock("gamma", 5000);

    let caught: unknown = null;
    try {
      // 30 ms queue-wait window — well under the 200 ms the first
      // holder will stay parked.
      await pubsub.lock("gamma", 30);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/timed out in queue/i);

    // The first holder must still be able to release cleanly — the
    // timeout on the queued waiter should not have torn down the
    // executor that's currently holding the lock.
    await firstUnlock();

    // And a fresh acquire on the same key after the timeout + release
    // must succeed without re-triggering the bug.
    const thirdUnlock = await pubsub.lock("gamma", 100);
    await thirdUnlock();

    // The fix is specifically about *not* producing an
    // unhandledRejection. If this fails, the rejection escaped the
    // lock() promise and the original process-killing bug is back.
    expect(unhandled).toHaveLength(0);
  });

  it("different keys do not block each other", async () => {
    const pubsub = new PubSub();
    const a = await pubsub.lock("k1", 100);
    const b = await pubsub.lock("k2", 100);
    await a();
    await b();
    expect(unhandled).toHaveLength(0);
  });
});

describe("PubSub failures", () => {
  it("observes Redis publish rejection instead of leaking an unhandled promise", async () => {
    const pubsub = new PubSub();
    const failure = new Error("publish failed");
    const publish = vi.fn().mockRejectedValue(failure);
    (pubsub as any).redisWrite = { publish };
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});

    pubsub.emit("change", { id: "x" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(publish).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      'PubSub publish failed for "change":',
      failure,
    );
    logged.mockRestore();
  });

  it("attempts to close every Redis client when one quit fails", async () => {
    const pubsub = new PubSub();
    const clients = [
      {
        quit: vi.fn(() => {
          throw new Error("lock failed");
        }),
        disconnect: vi.fn(),
      },
      { quit: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn() },
      { quit: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn() },
    ];
    (pubsub as any).redisLock = clients[0];
    (pubsub as any).redisRead = clients[1];
    (pubsub as any).redisWrite = clients[2];

    await expect(pubsub.close()).rejects.toThrow(
      "Failed to close PubSub Redis clients",
    );
    for (const client of clients) {
      expect(client.quit).toHaveBeenCalledTimes(1);
    }
    expect(clients[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(clients[1]!.disconnect).not.toHaveBeenCalled();
    expect(clients[2]!.disconnect).not.toHaveBeenCalled();
  });
});

describe("global lock context", () => {
  it("fails explicitly before app services are installed", async () => {
    _clearServices();
    await expect(lock("before-start")).rejects.toThrow(
      "services are not initialized",
    );
  });
});
