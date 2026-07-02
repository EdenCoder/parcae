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

  const recentTime = recentlyQueued.get(jobId);
  if (recentTime && Date.now() - recentTime < RECENT_QUEUE_TTL_MS) {
    return null;
  }

  recentlyQueued.set(jobId, Date.now());

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

  return queue.add(name, data, {
    jobId,
    removeOnComplete: options.removeOnComplete ?? 100,
    removeOnFail: options.removeOnFail ?? 50,
  });
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
   * BullMQ queue named `${defaultName}:${jobName}`. The bare `defaultName`
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
   * BullMQ v5 rejects colons in queue names, so any colons (from the
   * namespace separator OR from a colon-style job name like `post:index`)
   * are collapsed to dashes. Job names themselves keep their original
   * shape — only the derived queue name is sanitised.
   *
   * @example
   * queueNameFor("panel")                    → "parcae-panel"
   * queueNameFor("project-asset.image")      → "parcae-project-asset.image"
   * queueNameFor("post:index")               → "parcae-post-index"
   */
  queueNameFor(jobName: string): string {
    return `${this.defaultName}:${jobName}`.split(":").join("-");
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

  /** Create a Worker for a queue. */
  createWorker(
    name: string,
    processor: (job: Job) => Promise<any>,
    concurrency = 1,
  ): Worker | null {
    if (!this.sharedRedis) return null;

    const worker = new Worker(name, processor, {
      // See `get()` for the cast rationale — same dual-ioredis story.
      connection: this.sharedRedis as unknown as ConnectionOptions,
      concurrency,
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
}
