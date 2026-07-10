/**
 * Tests for `QueueService` — shared ioredis sharing for BullMQ.
 *
 * Production cost model: with N registered jobs (= N Queues + N Workers),
 * BullMQ used to open ~3N Redis connections per worker process:
 *   - 1 ioredis per Queue (command ops)
 *   - 1 ioredis per Worker (command ops)
 *   - 1 ioredis per Worker (blocking — BLMOVE, etc.)
 *
 * The fix (DOL-1043): construct ONE shared `IORedis` instance at
 * QueueService boot, pass it to every Queue + Worker constructor.
 * BullMQ recognises the shared instance and:
 *   - Reuses it for command ops on every Queue + Worker.
 *   - Calls `.duplicate()` per Worker to create a fresh blocking
 *     connection (this can't be shared by design — blocking ops would
 *     serialize across the workers).
 *
 * Result: 3N → N+1 connections per process. For 30 jobs: 90 → 31.
 *
 * We mock `bullmq` and `ioredis` to keep the test hermetic — verifying
 * that the right *thing* gets passed to BullMQ rather than that BullMQ
 * itself does what we expect (BullMQ has its own tests for that).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ───────────────────────────────────────────────
//
// vi.mock factory functions are hoisted above the imports, so any
// reference to outer state must go through `vi.hoisted(...)`. We
// stash the constructor spies + the doubles they produce here so the
// real test code below can inspect what QueueService passed in.

const mocks = vi.hoisted(() => {
  const ioredisInstances: any[] = [];
  const queueInstances: any[] = [];
  const workerInstances: any[] = [];

  const IORedis = vi.fn().mockImplementation(function (
    this: any,
    ...args: any[]
  ) {
    this.constructorArgs = args;
    this.quit = vi.fn(async () => {});
    this.disconnect = vi.fn(() => {});
    this.duplicate = vi.fn(() => ({ duplicated: true, quit: vi.fn() }));
    // ioredis instances have a stash of options BullMQ inspects via
    // `instance.options`. We mirror just enough for isRedisInstance()
    // and the `maxRetriesPerRequest` check to be happy.
    this.options = args[1] ?? {};
    // BullMQ checks `instance instanceof Redis` via duck-typing on
    // its internal helpers. The simplest way to satisfy
    // `isRedisInstance()` is to expose status + ioredis-shaped API.
    this.status = "ready";
    ioredisInstances.push(this);
  });

  // BullMQ's `isRedisInstance` (utils/is-redis-instance.js) checks
  // `arg instanceof Redis || arg.constructor.name === 'Redis'`. We
  // make the mock report its constructor.name as "Redis".
  Object.defineProperty(IORedis, "name", { value: "Redis" });

  const Queue = vi.fn().mockImplementation(function (
    this: any,
    name: string,
    opts: any,
  ) {
    this.name = name;
    this.opts = opts;
    this.close = vi.fn(async () => {});
    queueInstances.push(this);
  });

  const Worker = vi.fn().mockImplementation(function (
    this: any,
    name: string,
    processor: any,
    opts: any,
  ) {
    this.name = name;
    this.processor = processor;
    this.opts = opts;
    this.close = vi.fn(async () => {});
    workerInstances.push(this);
  });

  const Job = { fromId: vi.fn() };

  return {
    IORedis,
    Queue,
    Worker,
    Job,
    ioredisInstances,
    queueInstances,
    workerInstances,
    reset() {
      ioredisInstances.length = 0;
      queueInstances.length = 0;
      workerInstances.length = 0;
      IORedis.mockClear();
      Queue.mockClear();
      Worker.mockClear();
      Job.fromId.mockReset();
    },
  };
});

vi.mock("ioredis", () => ({
  default: mocks.IORedis,
  Redis: mocks.IORedis,
}));

vi.mock("bullmq", () => ({
  Queue: mocks.Queue,
  Worker: mocks.Worker,
  Job: mocks.Job,
}));

// Late import so the mocks above are in place.
import { QueueService, addJobIfNotExists } from "../services/queue";

describe("QueueService — shared ioredis", () => {
  beforeEach(() => {
    mocks.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a single shared ioredis instance when a URL is provided", async () => {
    const svc = new QueueService({ url: "redis://localhost:6379" });
    await svc.building;

    // Exactly one IORedis instance should be constructed at boot —
    // shared by every Queue and Worker downstream.
    expect(mocks.IORedis).toHaveBeenCalledTimes(1);
  });

  it("constructs the shared instance with maxRetriesPerRequest: null", async () => {
    const svc = new QueueService({ url: "redis://localhost:6379" });
    await svc.building;

    // BullMQ requires `maxRetriesPerRequest: null` on any ioredis
    // instance used for blocking commands. Since the shared instance
    // is duplicated by BullMQ to create per-Worker blocking
    // connections (those inherit the original's options), the
    // root-level instance MUST set it.
    const lastCall = (mocks.IORedis as any).mock.calls.at(-1) ?? [];
    const opts = lastCall.find(
      (a: any) => a && typeof a === "object" && "maxRetriesPerRequest" in a,
    );
    expect(opts?.maxRetriesPerRequest).toBeNull();
  });

  it("does NOT create an ioredis when no URL is provided (in-process fallback)", async () => {
    const svc = new QueueService({});
    await svc.building;
    expect(mocks.IORedis).not.toHaveBeenCalled();
    expect(svc.get()).toBeNull();
  });

  it("passes the shared ioredis instance to every Queue (not a ConnectionOptions object)", async () => {
    const svc = new QueueService({ url: "redis://localhost:6379" });
    await svc.building;

    const sharedRedis = mocks.ioredisInstances[0];
    expect(sharedRedis).toBeDefined();

    const queueA = svc.get("queue-a");
    const queueB = svc.get("queue-b");
    expect(queueA).not.toBeNull();
    expect(queueB).not.toBeNull();

    expect(mocks.Queue).toHaveBeenCalledTimes(2);
    // Both Queues must receive the same shared ioredis as their
    // `connection`. If the code were still passing the plain options
    // object, BullMQ would construct its own ioredis per Queue.
    expect(mocks.queueInstances[0]!.opts.connection).toBe(sharedRedis);
    expect(mocks.queueInstances[1]!.opts.connection).toBe(sharedRedis);
  });

  it("passes the shared ioredis instance to every Worker", async () => {
    const svc = new QueueService({ url: "redis://localhost:6379" });
    await svc.building;

    const sharedRedis = mocks.ioredisInstances[0];

    const processor = async () => {};
    svc.createWorker("queue-a", processor, 2);
    svc.createWorker("queue-b", processor, 4);

    expect(mocks.Worker).toHaveBeenCalledTimes(2);
    expect(mocks.workerInstances[0]!.opts.connection).toBe(sharedRedis);
    expect(mocks.workerInstances[1]!.opts.connection).toBe(sharedRedis);
    // The concurrency arg still propagates correctly (DOL-180).
    expect(mocks.workerInstances[0]!.opts.concurrency).toBe(2);
    expect(mocks.workerInstances[1]!.opts.concurrency).toBe(4);
  });

  it("reuses the same Queue instance for repeated get(name) — no new ioredis or Queue", async () => {
    const svc = new QueueService({ url: "redis://localhost:6379" });
    await svc.building;

    const first = svc.get("queue-a");
    const second = svc.get("queue-a");
    expect(first).toBe(second);
    expect(mocks.Queue).toHaveBeenCalledTimes(1);
    // Still just the one shared ioredis from boot.
    expect(mocks.IORedis).toHaveBeenCalledTimes(1);
  });

  it("close() quits the shared ioredis after closing queues + workers", async () => {
    const svc = new QueueService({ url: "redis://localhost:6379" });
    await svc.building;

    const sharedRedis = mocks.ioredisInstances[0];
    svc.get("queue-a");
    svc.createWorker("queue-a", async () => {});

    await svc.close();

    // Both Queue and Worker closed.
    expect(mocks.queueInstances[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.workerInstances[0]!.close).toHaveBeenCalledTimes(1);
    // Then the shared connection.
    expect(sharedRedis.quit).toHaveBeenCalledTimes(1);
  });

  it("close() is a safe no-op when no URL was provided", async () => {
    const svc = new QueueService({});
    await svc.building;
    await expect(svc.close()).resolves.toBeUndefined();
    expect(mocks.IORedis).not.toHaveBeenCalled();
  });

  it("forceClose aborts workers and disconnects Redis without awaiting drain", async () => {
    const svc = new QueueService({ url: "redis://localhost:6379" });
    await svc.building;
    const redis = mocks.ioredisInstances[0];
    svc.get("queue-a");
    svc.createWorker("queue-a", async () => {});

    svc.forceClose();

    expect(mocks.workerInstances[0]!.close).toHaveBeenCalledWith(true);
    expect(mocks.queueInstances[0]!.close).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).toHaveBeenCalledWith(false);
    expect(svc.get()).toBeNull();
  });

  it("handles TLS rediss:// URLs (passes tls option through to ioredis)", async () => {
    const svc = new QueueService({
      url: "rediss://user:pass@my-host:6380",
    });
    await svc.building;

    const lastCall = (mocks.IORedis as any).mock.calls.at(-1) ?? [];
    const opts = lastCall.find(
      (a: any) => a && typeof a === "object" && ("tls" in a || "host" in a),
    );
    expect(opts?.host).toBe("my-host");
    expect(opts?.port).toBe(6380);
    expect(opts?.username).toBe("user");
    expect(opts?.password).toBe("pass");
    expect(opts?.tls).toBeDefined();
  });
});

describe("addJobIfNotExists", () => {
  beforeEach(() => {
    mocks.Job.fromId.mockReset().mockResolvedValue(null);
  });

  it("keys the recent cache by queue and job id", async () => {
    const queueA = {
      name: "queue-a",
      add: vi.fn(async () => ({ id: "same" })),
    };
    const queueB = {
      name: "queue-b",
      add: vi.fn(async () => ({ id: "same" })),
    };

    await addJobIfNotExists(queueA as any, "build", {}, { jobId: "same" });
    await addJobIfNotExists(queueB as any, "build", {}, { jobId: "same" });

    expect(queueA.add).toHaveBeenCalledTimes(1);
    expect(queueB.add).toHaveBeenCalledTimes(1);
  });

  it("only records the recent cache after enqueue succeeds", async () => {
    const queue = {
      name: "queue-retry",
      add: vi
        .fn()
        .mockRejectedValueOnce(new Error("redis unavailable"))
        .mockResolvedValueOnce({ id: "retry" }),
    };

    await expect(
      addJobIfNotExists(queue as any, "build", {}, { jobId: "retry" }),
    ).rejects.toThrow("redis unavailable");
    await expect(
      addJobIfNotExists(queue as any, "build", {}, { jobId: "retry" }),
    ).resolves.toEqual({ id: "retry" });
    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});
