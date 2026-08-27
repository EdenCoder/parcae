/**
 * Queue — BullMQ queue + worker management.
 *
 * Optional — if REDIS_URL not set, jobs run in-process synchronously.
 * Extracted from Dollhouse Studio's utilities/queue.ts (172 lines).
 *
 * ── Connection sharing ───────────────────────────────────────────
 *
 * BullMQ Queues and Workers open one ioredis client each for command
 * ops; Workers additionally duplicate the connection to get a fresh
 * blocking-mode ioredis for BRPOPLPUSH-style ops. Naively passing a
 * `ConnectionOptions` object to every constructor results in
 * `2N + 1` ioredis clients per pod (N Queues + N Workers + the
 * `N` extra blocking duplicates). On managed Redis with low
 * connection limits this constrains worker scale-out.
 *
 * The fix here: open **one** shared `IORedis` at QueueService boot
 * with `maxRetriesPerRequest: null` (required for blocking), then pass
 * that instance to every Queue and Worker. BullMQ recognises the
 * shared instance and:
 *   - Reuses it directly for command ops on every Queue + Worker.
 *   - Calls `.duplicate()` per Worker to get a fresh blocking
 *     connection. The duplicates inherit the parent's options, so
 *     they pick up `maxRetriesPerRequest: null` automatically.
 *
 * Result: 1 shared command connection + 1 blocking connection per
 * Worker = `N+1` total instead of `3N`. For 30 jobs: 90 → 31.
 */

import { Queue, Worker, Job, type ConnectionOptions } from "bullmq";
import IORedis, { type RedisOptions } from "ioredis";

// ─── Dedup Cache ─────────────────────────────────────────────────────────────

const recentlyQueued = new Map<string, number>();
const RECENT_QUEUE_TTL_MS = 5000;

/**
 * Add a job if it doesn't already exist (waiting/active/delayed).
 * In-memory TTL cache + BullMQ jobId dedup.
 */
export async function addJobIfNotExists(
  queue: Queue,
  name: string,
  data: any,
  options: {
    jobId: string;
    removeOnComplete?: number | boolean;
    removeOnFail?: number | boolean;
  },
): Promise<Job | null> {
  const { jobId } = options;

  const cacheKey = `${queue.name}\0${jobId}`;
  const recentTime = recentlyQueued.get(cacheKey);
  if (recentTime && Date.now() - recentTime < RECENT_QUEUE_TTL_MS) {
    return null;
  }

  if (recentlyQueued.size > 1000) {
    const now = Date.now();
    for (const [key, time] of recentlyQueued) {
      if (now - time > RECENT_QUEUE_TTL_MS) recentlyQueued.delete(key);
    }
  }

  const existing = await Job.fromId(queue, jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "waiting" || state === "active" || state === "delayed")
      return null;
    try {
      await existing.remove();
    } catch {}
  }

  const added = await queue.add(name, data, {
    jobId,
    removeOnComplete: options.removeOnComplete ?? 100,
    removeOnFail: options.removeOnFail ?? 50,
  });
  recentlyQueued.set(cacheKey, Date.now());
  return added;
}

/**
 * BullMQ v5 rejects colons in queue names. Percent-escaping both `%`
 * and `:` keeps the mapping injective (`post:index` cannot collide
 * with `post-index` or the literal `post%3Aindex`).
 */
const escapeQueueName = (value: string): string =>
  value.replace(/%/g, "%25").replace(/:/g, "%3A");

/**
 * The states a job can sit in on a queue nothing consumes. `paused`
 * matters because pausing RENAMEs the wait list, and `active` because
 * a job pulled by a worker that then died is only recovered by a
 * running worker's stalled check, which an orphan queue has none of.
 */
const UNDONE_LIST_KEYS = ["wait", "paused", "active"] as const;
const UNDONE_ZSET_KEYS = ["delayed", "prioritized"] as const;

/** A queue holding undone jobs that no registered job maps to. */
export interface OrphanQueue {
  queue: string;
  wait: number;
  paused: number;
  active: number;
  delayed: number;
  prioritized: number;
}

/**
 * `incomplete` means the scan could not see the whole keyspace: it
 * timed out, or Redis refused a command. It must be reported, because
 * a scan that could not run looks exactly like one that found nothing.
 */
export interface OrphanScanResult {
  orphans: OrphanQueue[];
  incomplete: boolean;
}

/** How long the advisory scan may take before it gives up. */
const ORPHAN_SCAN_TIMEOUT_MS = 5000;

/**
 * Render the boot warning for a scan result, or `null` when there is
 * nothing to say. Kept separate from the scan so the wording is
 * testable without a Redis keyspace.
 */
export function formatOrphanQueueWarning(
  result: OrphanScanResult,
): string | null {
  const { orphans, incomplete } = result;
  if (orphans.length === 0 && !incomplete) return null;

  const caveat = incomplete
    ? " The scan was INCOMPLETE (timed out or Redis refused a command), so this list may be partial."
    : "";
  if (orphans.length === 0) {
    return `[jobs] the orphan-queue scan could not complete, so nothing was checked.${caveat}`;
  }

  const detail = orphans
    .map(
      (o) =>
        `${o.queue} (wait=${o.wait}, paused=${o.paused}, active=${o.active}, delayed=${o.delayed}, prioritized=${o.prioritized})`,
    )
    .join(", ");
  return (
    `[jobs] ${orphans.length} queue(s) hold undone jobs that no registered job consumes: ${detail}. ` +
    `Usually a renamed job or a change to the queue-name mapping; the jobs are NOT drained and will wait forever. ` +
    `Check the name against queueNameFor before draining anything: a sibling service whose JOB_QUEUE_NAME extends this one shares the prefix and its live queues can appear here.${caveat}`
  );
}

// ─── QueueService ────────────────────────────────────────────────────────────

export interface QueueConfig {
  /** Redis URL. If not provided, jobs won't be queued. */
  url?: string;
  /** Default queue name. Default: "parcae" */
  name?: string;
}

export class QueueService {
  /**
   * Single ioredis instance shared by every Queue and Worker this
   * service owns. `null` in the in-process fallback (no Redis URL).
   * See the file-level JSDoc for the connection-sharing rationale.
   */
  private sharedRedis: IORedis | null = null;
  private queues = new Map<string, Queue>();
  private workers = new Map<string, Worker>();
  /**
   * Namespace prefix for all queue names. Each registered job gets its own
   * BullMQ queue named `${defaultName}-${jobName}`, percent-escaped by
   * `queueNameFor`. The bare `defaultName`
   * queue is reserved as a transitional fallback for in-flight legacy jobs
   * enqueued before the per-name routing landed (see app.ts Step 15).
   */
  public readonly defaultName: string;
  public building: Promise<void>;

  constructor(config: QueueConfig = {}) {
    this.defaultName = config.name ?? "parcae";
    this.building = config.url ? this.build(config.url) : Promise.resolve();
  }

  /**
   * Resolve a registered job name into its BullMQ queue name.
   * Per-job-name queues let workers subscribe selectively (RUN_JOBS=a,b)
   * and let third-party consumers pick up specific jobs without colliding
   * with each other.
   *
   * BullMQ v5 rejects colons in queue names. Percent-escaping both `%` and
   * `:` keeps the mapping injective (`post:index` cannot collide with
   * `post-index` or the literal `post%3Aindex`).
   *
   * @example
   * queueNameFor("panel")                    → "parcae-panel"
   * queueNameFor("project-asset.image")      → "parcae-project-asset.image"
   * queueNameFor("post:index")               → "parcae-post%3Aindex"
   */
  queueNameFor(jobName: string): string {
    return `${escapeQueueName(this.defaultName)}-${escapeQueueName(jobName)}`;
  }

  /**
   * Advisory scan for queues in this service's namespace that no
   * registered job maps to but that still hold undone jobs. A
   * queue-naming change strands such jobs silently: the old queue
   * keeps serving plausible stats while nothing consumes it, and a job
   * added there waits forever with no error. This scan is the only
   * signal.
   *
   * It reports, never drains, and is bounded by its own deadline. The
   * deadline is load-bearing rather than defensive: the shared ioredis
   * carries `maxRetriesPerRequest: null` (BullMQ requires it for
   * blocking ops), and ioredis only flushes pending commands with an
   * error when that option is a number. A command issued while the
   * connection is down therefore never settles and never rejects, so
   * without a deadline an awaiting caller waits out the whole outage.
   *
   * Scope: the bare `defaultName` queue plus names under the
   * `${defaultName}-` prefix. That prefix is shared with any sibling
   * service whose own name extends this one, so a reported queue is a
   * candidate to investigate, not proof of a dead queue.
   */
  async findOrphanQueues(
    registeredQueueNames: Iterable<string>,
    opts: { timeoutMs?: number } = {},
  ): Promise<OrphanScanResult> {
    if (!this.sharedRedis) return { orphans: [], incomplete: false };
    const redis = this.sharedRedis;
    const known = new Set(registeredQueueNames);
    const prefix = `${escapeQueueName(this.defaultName)}-`;
    const orphans: OrphanQueue[] = [];

    const deadline = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(
        () => resolve("timeout"),
        opts.timeoutMs ?? ORPHAN_SCAN_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    /** Resolves "timeout" rather than hanging on a stuck connection. */
    const bounded = async <T>(work: Promise<T>): Promise<T | "timeout"> =>
      Promise.race([work, deadline]);

    try {
      const names: string[] = [];
      let cursor = "0";
      do {
        const page = await bounded(
          redis.scan(cursor, "MATCH", "bull:*:meta", "COUNT", "500"),
        );
        if (page === "timeout") return { orphans, incomplete: true };
        const [next, keys] = page;
        cursor = next;
        for (const key of keys) names.push(key.slice(5, -5));
      } while (cursor !== "0");

      for (const name of names.sort()) {
        if (name !== this.defaultName && !name.startsWith(prefix)) continue;
        if (known.has(name)) continue;
        const base = `bull:${name}:`;
        const counts = await bounded(
          Promise.all([
            ...UNDONE_LIST_KEYS.map(
              async (key) => [key, await redis.llen(`${base}${key}`)] as const,
            ),
            ...UNDONE_ZSET_KEYS.map(
              async (key) => [key, await redis.zcard(`${base}${key}`)] as const,
            ),
          ]),
        );
        if (counts === "timeout") return { orphans, incomplete: true };
        const undone = Object.fromEntries(counts) as Record<
          (typeof UNDONE_LIST_KEYS)[number] | (typeof UNDONE_ZSET_KEYS)[number],
          number
        >;
        const total = counts.reduce((sum, [, count]) => sum + count, 0);
        if (total > 0) {
          orphans.push({ queue: name, ...undone });
        }
      }
    } catch {
      // Report what was gathered, and say it is not the whole picture.
      return { orphans, incomplete: true };
    }
    return { orphans, incomplete: false };
  }

  private async build(url: string): Promise<void> {
    // Parse Redis URL into the option shape ioredis accepts.
    const parsed = new URL(url);
    const isTLS = parsed.protocol === "rediss:";
    const opts: RedisOptions = {
      host: parsed.hostname,
      port: parseInt(parsed.port || "6379"),
      password: parsed.password || undefined,
      username: parsed.username || undefined,
      // Required by BullMQ for any connection that will service
      // blocking commands. Since BullMQ duplicates this instance to
      // build per-Worker blocking connections, the duplicates inherit
      // this and the BullMQ validation never trips.
      maxRetriesPerRequest: null,
      ...(isTLS ? { tls: { rejectUnauthorized: false } } : {}),
    };
    this.sharedRedis = new IORedis(opts);
  }

  /** Get or create a Queue by name. */
  get(name?: string): Queue | null {
    if (!this.sharedRedis) return null;

    const queueName = name ?? this.defaultName;
    if (this.queues.has(queueName)) return this.queues.get(queueName)!;

    const queue = new Queue(queueName, {
      // BullMQ pins its own ioredis version transitively; the
      // `Redis` class it exposes via `ConnectionOptions` is structurally
      // identical but treated as a different type by TS thanks to
      // protected-member identity. Cast through `unknown` here so
      // the assignment compiles without forcing a peer-dep pin.
      connection: this.sharedRedis as unknown as ConnectionOptions,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    });

    this.queues.set(queueName, queue);
    return queue;
  }

  /**
   * Create a Worker for a queue.
   *
   * `tuning` accepts a bare concurrency number for the common case, or
   * the full shape when a job needs its lock behaviour changed too —
   * see `JobOptions.lockDuration` for why a long-running job wants a
   * say in that.
   */
  createWorker(
    name: string,
    processor: (job: Job) => Promise<any>,
    tuning:
      | number
      | {
          concurrency?: number;
          lockDuration?: number;
          maxStalledCount?: number;
        } = 1,
  ): Worker | null {
    if (!this.sharedRedis) return null;

    const opts = typeof tuning === "number" ? { concurrency: tuning } : tuning;

    const worker = new Worker(name, processor, {
      // See `get()` for the cast rationale — same dual-ioredis story.
      connection: this.sharedRedis as unknown as ConnectionOptions,
      concurrency: opts.concurrency ?? 1,
      // Left undefined, BullMQ applies its own defaults (30_000 / 1).
      ...(opts.lockDuration === undefined
        ? {}
        : { lockDuration: opts.lockDuration }),
      ...(opts.maxStalledCount === undefined
        ? {}
        : { maxStalledCount: opts.maxStalledCount }),
    });

    this.workers.set(name, worker);
    return worker;
  }

  /**
   * Return a "connection handle" suitable for passing to other
   * BullMQ consumers in the same process (e.g. QueueEvents). Callers
   * get the shared ioredis instance directly when one was opened, or
   * `null` in the in-process fallback. The return type is widened to
   * `ConnectionOptions` so external code that historically expected
   * a `RedisOptions`-shaped object continues to typecheck — BullMQ's
   * `ConnectionOptions` union accepts both shapes.
   */
  getConnection(): ConnectionOptions | null {
    return this.sharedRedis as unknown as ConnectionOptions | null;
  }

  /** Close all queues and workers, then the shared connection. */
  async close(): Promise<void> {
    await Promise.all([
      ...Array.from(this.queues.values()).map((q) => q.close()),
      ...Array.from(this.workers.values()).map((w) => w.close()),
    ]);
    this.queues.clear();
    this.workers.clear();
    if (this.sharedRedis) {
      try {
        await this.sharedRedis.quit();
      } catch {
        // ioredis throws when the connection is already gone — ignore.
      }
      this.sharedRedis = null;
    }
  }

  /** Abort graceful draining and synchronously sever every Redis connection. */
  forceClose(): void {
    const queues = [...this.queues.values()];
    const workers = [...this.workers.values()];
    const redis = this.sharedRedis;
    this.queues.clear();
    this.workers.clear();
    this.sharedRedis = null;

    for (const worker of workers) {
      void worker.close(true).catch(() => {});
    }
    for (const queue of queues) {
      void queue.close().catch(() => {});
    }
    redis?.disconnect(false);
  }
}
