/**
 * Queue — BullMQ queue + worker management.
 *
 * Optional — if REDIS_URL not set, jobs run in-process synchronously.
 * Extracted from Dollhouse Studio's utilities/queue.ts (172 lines).
 */

import { Queue, Worker, Job, type ConnectionOptions } from "bullmq";

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
  private connection: ConnectionOptions | null = null;
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
    // Parse Redis URL into connection options
    const parsed = new URL(url);
    const isTLS = parsed.protocol === "rediss:";
    this.connection = {
      host: parsed.hostname,
      port: parseInt(parsed.port || "6379"),
      password: parsed.password || undefined,
      username: parsed.username || undefined,
      ...(isTLS ? { tls: { rejectUnauthorized: false } } : {}),
    };
  }

  /** Get or create a Queue by name. */
  get(name?: string): Queue | null {
    if (!this.connection) return null;

    const queueName = name ?? this.defaultName;
    if (this.queues.has(queueName)) return this.queues.get(queueName)!;

    const queue = new Queue(queueName, {
      connection: this.connection,
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
    if (!this.connection) return null;

    const worker = new Worker(name, processor, {
      connection: this.connection,
      concurrency,
    });

    this.workers.set(name, worker);
    return worker;
  }

  /** Get the raw Redis connection config. */
  getConnection(): ConnectionOptions | null {
    return this.connection;
  }

  /** Close all queues and workers. */
  async close(): Promise<void> {
    await Promise.all([
      ...Array.from(this.queues.values()).map((q) => q.close()),
      ...Array.from(this.workers.values()).map((w) => w.close()),
    ]);
    this.queues.clear();
    this.workers.clear();
  }
}
