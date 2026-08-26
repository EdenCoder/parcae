/**
 * Tests for `QueueService.findOrphanQueues` — the advisory boot-time
 * scan that reports queues in this service's namespace holding undone
 * jobs that no registered job maps to. A queue-naming change (e.g. the
 * colon-to-percent-escape cutover) silently orphans old-named queues:
 * their stats stay plausible and a job added to one waits forever with
 * no error. The scan is the only signal; it must never drain, mutate,
 * or delay boot.
 *
 * Same hermetic approach as queue.test.ts: bullmq + ioredis are
 * mocked; a fake keyspace drives scan/llen/zcard so the scan's own
 * selection logic is what is under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const ioredisInstances: any[] = [];

  const IORedis = vi.fn().mockImplementation(function (
    this: any,
    ...args: any[]
  ) {
    this.constructorArgs = args;
    this.quit = vi.fn(async () => {});
    this.disconnect = vi.fn(() => {});
    this.duplicate = vi.fn(() => ({ duplicated: true, quit: vi.fn() }));
    this.options = args[1] ?? {};
    this.status = "ready";
    ioredisInstances.push(this);
  });
  Object.defineProperty(IORedis, "name", { value: "Redis" });

  const Queue = vi.fn().mockImplementation(function (this: any, name: string) {
    this.name = name;
    this.close = vi.fn(async () => {});
  });
  const Worker = vi.fn().mockImplementation(function (this: any) {
    this.close = vi.fn(async () => {});
  });

  return {
    IORedis,
    Queue,
    Worker,
    Job: { fromId: vi.fn() },
    ioredisInstances,
    reset() {
      ioredisInstances.length = 0;
      IORedis.mockClear();
      Queue.mockClear();
      Worker.mockClear();
    },
  };
});

vi.mock("ioredis", () => ({ default: mocks.IORedis, Redis: mocks.IORedis }));
vi.mock("bullmq", () => ({
  Queue: mocks.Queue,
  Worker: mocks.Worker,
  Job: mocks.Job,
}));

import {
  QueueService,
  formatOrphanQueueWarning,
  type OrphanScanResult,
} from "../services/queue";

type Counts = {
  wait?: number;
  paused?: number;
  active?: number;
  delayed?: number;
  prioritized?: number;
};

/**
 * Serve `queues` as the Redis keyspace. `pageSize` forces SCAN to
 * paginate so a scan that ignores the returned cursor is caught.
 */
function stubKeyspace(
  redis: any,
  queues: Record<string, Counts>,
  pageSize = 100,
) {
  const keys = Object.keys(queues).map((name) => `bull:${name}:meta`);
  redis.scan = vi.fn(async (cursor: string, ..._rest: any[]) => {
    const start = Number(cursor);
    const page = keys.slice(start, start + pageSize);
    const next = start + pageSize >= keys.length ? "0" : String(start + pageSize);
    return [next, page];
  });
  const read = (key: string, field: keyof Counts) => {
    const name = new RegExp(`^bull:(.+):${field}$`).exec(key)?.[1];
    return name === undefined ? 0 : (queues[name]?.[field] ?? 0);
  };
  redis.llen = vi.fn(async (key: string) =>
    key.endsWith(":wait")
      ? read(key, "wait")
      : key.endsWith(":paused")
        ? read(key, "paused")
        : key.endsWith(":active")
          ? read(key, "active")
          : 0,
  );
  redis.zcard = vi.fn(async (key: string) =>
    key.endsWith(":delayed")
      ? read(key, "delayed")
      : key.endsWith(":prioritized")
        ? read(key, "prioritized")
        : 0,
  );
}

async function build(name?: string): Promise<{ svc: QueueService; redis: any }> {
  const svc = new QueueService({ url: "redis://localhost:6379", name });
  await svc.building;
  return { svc, redis: mocks.ioredisInstances[0] };
}

const row = (queue: string, counts: Counts) => ({
  queue,
  wait: 0,
  paused: 0,
  active: 0,
  delayed: 0,
  prioritized: 0,
  ...counts,
});

describe("QueueService.findOrphanQueues", () => {
  beforeEach(() => {
    mocks.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports an unregistered same-namespace queue holding waiting jobs, with counts", async () => {
    const { svc, redis } = await build();
    stubKeyspace(redis, {
      "parcae-fax-extract": { wait: 3 },
      "parcae-fax%3Aextract": { wait: 0 },
    });

    const result = await svc.findOrphanQueues(["parcae-fax%3Aextract"]);

    expect(result).toEqual({
      orphans: [row("parcae-fax-extract", { wait: 3 })],
      incomplete: false,
    });
  });

  it("counts every state a stranded job can sit in, not just wait", async () => {
    const { svc, redis } = await build();
    stubKeyspace(redis, {
      "parcae-a": { delayed: 2 },
      "parcae-b": { prioritized: 1 },
      // pause-7.lua RENAMEs wait to paused, so a paused orphan reports
      // wait=0 and would vanish from a wait-only scan.
      "parcae-c": { paused: 4 },
      // Pulled by a worker that then died: no worker remains to run the
      // stalled check, so these are stranded too.
      "parcae-d": { active: 1 },
    });

    const { orphans } = await svc.findOrphanQueues([]);

    expect(orphans).toEqual([
      row("parcae-a", { delayed: 2 }),
      row("parcae-b", { prioritized: 1 }),
      row("parcae-c", { paused: 4 }),
      row("parcae-d", { active: 1 }),
    ]);
  });

  it("matches only queue meta keys, so unrelated bull keys are never scanned", async () => {
    const { svc, redis } = await build();
    stubKeyspace(redis, { "parcae-x": { wait: 1 } });

    await svc.findOrphanQueues([]);

    expect(redis.scan).toHaveBeenCalledWith(
      expect.anything(),
      "MATCH",
      "bull:*:meta",
      expect.anything(),
      expect.anything(),
    );
  });

  it("follows the SCAN cursor to the end of a paginated keyspace", async () => {
    const { svc, redis } = await build();
    const queues: Record<string, Counts> = {};
    for (let i = 0; i < 12; i++) queues[`parcae-job${i}`] = {};
    // Only the last page holds the orphan, so a scan that stops after
    // the first page reports nothing.
    queues["parcae-stranded"] = { wait: 7 };
    stubKeyspace(redis, queues, 5);

    const { orphans } = await svc.findOrphanQueues([]);

    expect(orphans).toEqual([row("parcae-stranded", { wait: 7 })]);
  });

  it("stays silent on registered queues and on orphans with no undone jobs", async () => {
    const { svc, redis } = await build();
    stubKeyspace(redis, {
      "parcae-live%3Ajob": { wait: 5 },
      "parcae-history-only": {},
    });

    const { orphans } = await svc.findOrphanQueues(["parcae-live%3Ajob"]);

    expect(orphans).toEqual([]);
  });

  it("ignores queues outside this service's namespace", async () => {
    const { svc, redis } = await build();
    stubKeyspace(redis, {
      "otherapp-stranded": { wait: 9 },
      // Prefix must match `parcae-`, not merely start with `parcae`.
      parcaeish: { wait: 4 },
    });

    const { orphans } = await svc.findOrphanQueues([]);

    expect(orphans).toEqual([]);
  });

  it("reports the bare default-name queue when it holds stranded jobs", async () => {
    const { svc, redis } = await build();
    // The pre-per-name-routing trap: repeatables stranded on the bare
    // `parcae` queue that nothing consumes after the cutover.
    stubKeyspace(redis, { parcae: { wait: 16 } });

    const { orphans } = await svc.findOrphanQueues([]);

    expect(orphans).toEqual([row("parcae", { wait: 16 })]);
  });

  it("flags the scan incomplete instead of silently reporting a clean result", async () => {
    const { svc, redis } = await build();
    redis.scan = vi.fn(async () => {
      throw new Error("NOPERM this user has no permissions to run 'scan'");
    });

    const result = await svc.findOrphanQueues([]);

    // A scan that could not run must not look identical to a scan that
    // found nothing: this is the only signal there is.
    expect(result).toEqual({ orphans: [], incomplete: true });
  });

  it("marks a partial result incomplete when a per-queue read fails", async () => {
    const { svc, redis } = await build();
    stubKeyspace(redis, {
      "parcae-a": { wait: 1 },
      "parcae-b": { wait: 1 },
    });
    const realLlen = redis.llen;
    let calls = 0;
    redis.llen = vi.fn(async (key: string) => {
      if (++calls > 3) throw new Error("connection reset");
      return realLlen(key);
    });

    const result = await svc.findOrphanQueues([]);

    expect(result.incomplete).toBe(true);
    expect(result.orphans).toEqual([row("parcae-a", { wait: 1 })]);
  });

  it("gives up within the timeout when Redis never answers, so boot is never blocked", async () => {
    const { svc, redis } = await build();
    // A shared ioredis is built with maxRetriesPerRequest: null, which
    // BullMQ requires for blocking ops. ioredis only flushes pending
    // commands with an error when that option is a NUMBER, so a command
    // issued while the connection is down never settles and never
    // rejects. Without its own deadline the scan would hang start().
    redis.scan = vi.fn(() => new Promise(() => {}));

    const result = await svc.findOrphanQueues([], { timeoutMs: 20 });

    expect(result).toEqual({ orphans: [], incomplete: true });
  });

  it("returns a complete empty result in the in-process fallback (no Redis URL)", async () => {
    const svc = new QueueService({});
    await svc.building;

    await expect(svc.findOrphanQueues([])).resolves.toEqual({
      orphans: [],
      incomplete: false,
    });
  });

  it("scopes to its own configured name, not a sibling service sharing the Redis", async () => {
    // `parcae-two` is a different service on the same Redis. Its queues
    // start with `parcae-`, so a naive prefix test claims them and tells
    // the operator to drain queues another live service is draining.
    const { svc, redis } = await build("parcae-two");
    stubKeyspace(redis, {
      "parcae-fax%3Aextract": { wait: 2 },
      "parcae-two-fax%3Aextract": { wait: 0 },
      "parcae-two-old-name": { wait: 5 },
    });

    const { orphans } = await svc.findOrphanQueues(["parcae-two-fax%3Aextract"]);

    expect(orphans).toEqual([row("parcae-two-old-name", { wait: 5 })]);
  });
});

const complete = (orphans: OrphanScanResult["orphans"]): OrphanScanResult => ({
  orphans,
  incomplete: false,
});

describe("formatOrphanQueueWarning", () => {
  it("names each orphan queue with its undone counts", () => {
    const msg = formatOrphanQueueWarning(
      complete([
        row("parcae-fax-extract", { wait: 3 }),
        row("parcae", { delayed: 2, prioritized: 1, paused: 4, active: 1 }),
      ]),
    );

    expect(msg).toContain("parcae-fax-extract");
    expect(msg).toContain("wait=3");
    expect(msg).toContain("delayed=2");
    expect(msg).toContain("prioritized=1");
    expect(msg).toContain("paused=4");
    expect(msg).toContain("active=1");
  });

  it("says nothing was drained, so the warning is never read as an action taken", () => {
    const msg = formatOrphanQueueWarning(
      complete([row("parcae-fax-extract", { wait: 3 })]),
    );

    expect(msg?.toLowerCase()).toContain("not drained");
  });

  it("warns when the scan could not finish, even with nothing found", () => {
    const msg = formatOrphanQueueWarning({ orphans: [], incomplete: true });

    // Silence here would report a broken detector as a clean bill.
    expect(msg).not.toBeNull();
    expect(msg?.toLowerCase()).toContain("incomplete");
  });

  it("marks a partial list as incomplete so it is not read as the full set", () => {
    const msg = formatOrphanQueueWarning({
      orphans: [row("parcae-fax-extract", { wait: 3 })],
      incomplete: true,
    });

    expect(msg).toContain("parcae-fax-extract");
    expect(msg?.toLowerCase()).toContain("incomplete");
  });

  it("returns null on a complete scan with no orphans, so boot stays silent", () => {
    expect(formatOrphanQueueWarning(complete([]))).toBeNull();
  });
});
