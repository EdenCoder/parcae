/**
 * @parcae/backend — job()
 *
 * Background job registration. Plain function API.
 *
 * @example
 * ```typescript
 * export default job("post:index", async ({ data }) => {
 *   const post = await Post.findById(data.postId);
 *   if (!post) return { skipped: true, reason: "Not found" };
 *   // ... index in search engine ...
 *   return { success: true };
 * });
 * ```
 *
 * @example With concurrency for 3rd-party API jobs:
 * ```typescript
 * export default job("dialogue:audio", async ({ data }) => {
 *   // call external TTS API ...
 * }, { concurrency: 24 });
 * ```
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface JobContext {
  /** Job payload data. */
  data: any;
  /** The BullMQ job instance. */
  bullJob?: any;
  /** Job attempt number. */
  attempt?: number;
}

export type JobHandler = (ctx: JobContext) => Promise<any>;

export interface JobOptions {
  /**
   * Max number of this job that can run concurrently in the worker.
   * The worker's overall concurrency is set to the highest value
   * across all registered jobs (minimum 1).
   */
  concurrency?: number;
  /**
   * How long BullMQ holds this job's lock, in ms. Default 30_000.
   *
   * The worker renews the lock every `lockDuration / 2` for as long as
   * it is alive, so this is not "how long the job may run" — it is the
   * window between a worker dying and the queue being allowed to hand
   * its job to someone else. 30s is right for short jobs and too tight
   * for one that spends minutes inside a single provider call, where a
   * momentarily busy event loop can miss a renewal and get the job
   * double-fired.
   *
   * Raise it for long jobs, but no further than you are willing to
   * wait for a dead worker's work to come back.
   */
  lockDuration?: number;
  /**
   * How many times this job may be reclaimed as stalled before BullMQ
   * fails it outright. Default 1 — meaning one worker death mid-job is
   * survivable and the second is terminal. Jobs that run long enough
   * to straddle a deploy or a dev-server restart want more.
   */
  maxStalledCount?: number;
}

export interface JobEntry {
  name: string;
  handler: JobHandler;
  options: JobOptions;
}

// ─── Global Job Registry ─────────────────────────────────────────────────────

const registeredJobs: JobEntry[] = [];

export function getJobs(): JobEntry[] {
  return [...registeredJobs];
}

export function getJob(name: string): JobEntry | undefined {
  return registeredJobs.find((j) => j.name === name);
}

export function clearJobs(): void {
  registeredJobs.length = 0;
}

// ─── Job registration ────────────────────────────────────────────────────────

/**
 * Register a background job processor.
 *
 * Registration is idempotent on `name`: if the same name is registered
 * more than once (which happens in real codebases when a `jobs/foo.ts`
 * file is imported as a side effect by something in `hooks/` or
 * `controllers/` _and then_ discovered directly by the auto-discovery
 * scan), the latest registration wins. Without this guard you'd end up
 * with N BullMQ Worker instances per job after the per-queue routing
 * change, each duplicating the Redis traffic.
 *
 * ```typescript
 * job("post:index", async ({ data }) => {
 *   const post = await Post.findById(data.postId);
 *   // ...
 *   return { success: true };
 * });
 *
 * // With concurrency for jobs that call external APIs:
 * job("dialogue:audio", handler, { concurrency: 24 });
 * ```
 */
export function job(
  name: string,
  handler: JobHandler,
  options: JobOptions = {},
): JobEntry {
  const entry: JobEntry = { name, handler, options };
  const existingIdx = registeredJobs.findIndex((j) => j.name === name);
  if (existingIdx >= 0) {
    registeredJobs[existingIdx] = entry;
  } else {
    registeredJobs.push(entry);
  }
  return entry;
}
