/**
 * Tests for `shutdownResources` — the helper that powers `app.stop()`.
 *
 * The helper is extracted out of the `app` factory closure so it can be
 * exercised with synthetic test doubles instead of needing a full
 * `createApp().start()` cycle. The contract it implements:
 *
 *   1. Stop accepting new HTTP/socket connections (io.close + httpServer.close)
 *   2. Stop schedulers and the Postgres change bus.
 *   3. Drain BullMQ workers with a bounded timeout (queue.close).
 *   4. Close PubSub Redis clients.
 *   5. Destroy Knex pools (writeDb first, readDb only when distinct).
 *
 * Errors in any single step are logged and never propagated — a slow Redis
 * shouldn't prevent the DB pool from closing, etc.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shutdownResources } from "../shutdown";

type SpyFn = ReturnType<typeof vi.fn>;

/**
 * Tiny builder that creates a fresh fake of every resource the shutdown
 * helper knows about. Each fake records the *order* in which its primary
 * close method was called via the shared `order` array, so we can assert
 * the contract without timing-dependent flakes.
 */
function makeFakes() {
  const order: string[] = [];
  const note = (label: string) => order.push(label);

  const io = {
    close: vi.fn((cb?: () => void) => {
      note("io.close");
      cb?.();
    }),
  };
  const httpServer = {
    close: vi.fn((cb: () => void) => {
      note("httpServer.close");
      // Callback fires asynchronously to mimic real http server behaviour.
      setImmediate(cb);
    }),
  };
  const cronA = { stop: vi.fn(() => note("cronA.stop")) };
  const cronB = { stop: vi.fn(() => note("cronB.stop")) };
  const changeBus = { stop: vi.fn(async () => note("changeBus.stop")) };
  const queue = {
    close: vi.fn(async () => {
      note("queue.close");
    }),
    forceClose: vi.fn(() => {
      note("queue.forceClose");
    }),
  };
  const pubsub = {
    close: vi.fn(async () => {
      note("pubsub.close");
    }),
  };
  const auth = {
    close: vi.fn(async () => {
      note("auth.close");
    }),
  };
  const writeDb = {
    destroy: vi.fn(async () => {
      note("writeDb.destroy");
    }),
  };
  const readDb = {
    destroy: vi.fn(async () => {
      note("readDb.destroy");
    }),
  };

  return {
    order,
    io,
    httpServer,
    cronA,
    cronB,
    changeBus,
    queue,
    pubsub,
    auth,
    writeDb,
    readDb,
  };
}

describe("shutdownResources", () => {
  // Silence the helper's log.warn so failed-resource tests don't pollute
  // the test output with red noise.
  let originalLog: typeof console.warn;

  beforeEach(() => {
    originalLog = console.warn;
    console.warn = () => {};
  });
  afterEach(() => {
    console.warn = originalLog;
  });

  it("calls close/destroy on every resource that is provided", async () => {
    const f = makeFakes();
    await shutdownResources({
      io: f.io as any,
      httpServer: f.httpServer as any,
      crons: [f.cronA as any, f.cronB as any],
      changeBus: f.changeBus as any,
      queue: f.queue as any,
      pubsub: f.pubsub as any,
      auth: f.auth as any,
      writeDb: f.writeDb as any,
      readDb: f.readDb as any,
    });

    expect(f.io.close).toHaveBeenCalledTimes(1);
    expect(f.httpServer.close).toHaveBeenCalledTimes(1);
    expect(f.cronA.stop).toHaveBeenCalledTimes(1);
    expect(f.cronB.stop).toHaveBeenCalledTimes(1);
    expect(f.changeBus.stop).toHaveBeenCalledTimes(1);
    expect(f.queue.close).toHaveBeenCalledTimes(1);
    expect(f.queue.forceClose).not.toHaveBeenCalled();
    expect(f.pubsub.close).toHaveBeenCalledTimes(1);
    expect(f.auth.close).toHaveBeenCalledTimes(1);
    expect(f.writeDb.destroy).toHaveBeenCalledTimes(1);
    expect(f.readDb.destroy).toHaveBeenCalledTimes(1);
  });

  it("skips resources that aren't provided without throwing", async () => {
    // No fields at all → no work to do.
    await expect(shutdownResources({})).resolves.toBeUndefined();

    // Just a DB → only DB is touched.
    const f = makeFakes();
    await shutdownResources({ writeDb: f.writeDb as any });
    expect(f.writeDb.destroy).toHaveBeenCalledTimes(1);
    expect(f.pubsub.close).not.toHaveBeenCalled();
    expect(f.queue.close).not.toHaveBeenCalled();
  });

  it("shuts down in the documented order: io → http → schedulers → queue → pubsub → db", async () => {
    const f = makeFakes();
    await shutdownResources({
      io: f.io as any,
      httpServer: f.httpServer as any,
      crons: [f.cronA as any],
      changeBus: f.changeBus as any,
      queue: f.queue as any,
      pubsub: f.pubsub as any,
      auth: f.auth as any,
      writeDb: f.writeDb as any,
      readDb: f.readDb as any,
    });

    // The relative ordering matters; absolute interleaving does not.
    // We assert position(a) < position(b) for every pair we care about.
    const ix = (label: string) => f.order.indexOf(label);
    expect(ix("io.close")).toBeGreaterThanOrEqual(0);
    expect(ix("io.close")).toBeLessThan(ix("httpServer.close"));
    expect(ix("httpServer.close")).toBeLessThan(ix("queue.close"));
    expect(ix("cronA.stop")).toBeLessThan(ix("queue.close"));
    expect(ix("changeBus.stop")).toBeLessThan(ix("queue.close"));
    expect(ix("queue.close")).toBeLessThan(ix("pubsub.close"));
    expect(ix("pubsub.close")).toBeLessThan(ix("auth.close"));
    expect(ix("auth.close")).toBeLessThan(ix("writeDb.destroy"));
    expect(ix("pubsub.close")).toBeLessThan(ix("writeDb.destroy"));
    expect(ix("pubsub.close")).toBeLessThan(ix("readDb.destroy"));
  });

  it("doesn't double-destroy readDb when readDb === writeDb", async () => {
    const f = makeFakes();
    // No read replica means both references point at the same Knex instance.
    await shutdownResources({
      writeDb: f.writeDb as any,
      readDb: f.writeDb as any,
    });
    expect(f.writeDb.destroy).toHaveBeenCalledTimes(1);
  });

  it("continues shutdown even when one resource throws", async () => {
    const f = makeFakes();
    (f.queue.close as SpyFn).mockImplementationOnce(async () => {
      throw new Error("queue meltdown");
    });
    (f.pubsub.close as SpyFn).mockImplementationOnce(async () => {
      throw new Error("pubsub meltdown");
    });

    await expect(
      shutdownResources({
        queue: f.queue as any,
        pubsub: f.pubsub as any,
        writeDb: f.writeDb as any,
      }),
    ).resolves.toBeUndefined();

    // Despite queue + pubsub blowing up, the DB pool still got closed.
    expect(f.writeDb.destroy).toHaveBeenCalledTimes(1);
  });

  it("times out queue drain when the workers hang", async () => {
    const f = makeFakes();
    (f.queue.close as SpyFn).mockImplementation(
      () => new Promise<void>(() => {}), // never resolves
    );

    const start = Date.now();
    await shutdownResources({
      queue: f.queue as any,
      pubsub: f.pubsub as any,
      drainTimeoutMs: 50,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(250); // generous: should be ~50ms
    expect(f.queue.forceClose).toHaveBeenCalledTimes(1);
    // Subsequent resources still ran even after the queue timed out.
    expect(f.pubsub.close).toHaveBeenCalledTimes(1);
  });

  it("treats httpServer.close as awaitable (waits for the callback)", async () => {
    const f = makeFakes();
    let httpServerClosed = false;
    (f.httpServer.close as SpyFn).mockImplementation((cb: () => void) => {
      setTimeout(() => {
        httpServerClosed = true;
        cb();
      }, 30);
    });

    await shutdownResources({
      httpServer: f.httpServer as any,
      pubsub: f.pubsub as any,
    });

    // pubsub.close must have run *after* httpServer.close callback fired.
    expect(httpServerClosed).toBe(true);
    expect(f.pubsub.close).toHaveBeenCalledTimes(1);
  });
});
