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
