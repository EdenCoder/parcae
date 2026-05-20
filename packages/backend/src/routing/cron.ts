/**
 * @parcae/backend — cron()
 *
 * Local in-process scheduled tasks. Crons are NOT BullMQ jobs — they fire
 * on a local node-cron-style scheduler (croner) and the handler runs
 * in-process. They share the registration shape and discovery story with
 * `job()` so files can sit next to each other in `crons/` and feel
 * familiar.
 *
 * Multi-instance safety: when more than one process has `RUN_CRONS=true`,
 * each tick is wrapped in a distributed try-lock keyed on the cron name
 * and the fire timestamp. The first process to acquire wins and runs the
 * handler; the rest silently skip. No extra plumbing required in
 * application code.
 *
 * @example
 * ```typescript
 * import { cron } from "@parcae/backend";
 *
 * export default cron("daily-digest", "0 7 * * *", async ({ data }) => {
 *   // data: { name, pattern, fireDate }
 *   await sendDigest();
 * });
 * ```
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Context passed to a cron handler. Shape mirrors `JobContext` so the two
 * registration APIs feel symmetric — `data` carries the metadata of the
 * tick (when it fired, against which pattern) instead of a payload.
 */
export interface CronContext {
  /**
   * Cron tick metadata. Crons have no enqueue payload, so `data` is the
   * tick info: which cron fired, on what pattern, and at what moment.
   */
  data: {
    name: string;
    pattern: string;
    fireDate: Date;
  };
}

export type CronHandler = (ctx: CronContext) => any | Promise<any>;

export interface CronOptions {
  /**
   * Whether the cron should still fire even when the previous tick is
   * still running. Default `false` — overlap is the most common footgun
   * for periodic jobs (each tick takes 30s, runs every minute → builds a
   * backlog).
   */
  overlap?: boolean;
  /**
   * Override the timezone the pattern is evaluated in. Defaults to the
   * process timezone (typically UTC on Cloud Run / k8s). Accepts any
   * IANA zone name, e.g. `"America/New_York"`.
   */
  timezone?: string;
}

export interface CronEntry {
  name: string;
  pattern: string;
  handler: CronHandler;
  options: CronOptions;
}

// ─── Global Cron Registry ────────────────────────────────────────────────────

const registeredCrons: CronEntry[] = [];

export function getCrons(): CronEntry[] {
  return [...registeredCrons];
}

export function getCron(name: string): CronEntry | undefined {
  return registeredCrons.find((c) => c.name === name);
}

export function clearCrons(): void {
  registeredCrons.length = 0;
}

// ─── Cron registration ───────────────────────────────────────────────────────

/**
 * Register a scheduled task. The handler fires on the cron pattern,
 * in-process, on every process that has `RUN_CRONS=true`. Cross-process
 * deduplication via distributed lock happens automatically at fire time.
 *
 * ```typescript
 * cron("post:cleanup", "0 * * * *", async ({ data }) => {
 *   // ...
 * });
 *
 * // Allow overlapping ticks (rare; you almost never want this):
 * cron("metrics", "*\/10 * * * * *", handler, { overlap: true });
 * ```
 */
export function cron(
  name: string,
  pattern: string,
  handler: CronHandler,
  options: CronOptions = {},
): CronEntry {
  if (!name || !name.trim()) {
    throw new Error("[cron] name is required");
  }
  if (!pattern || !pattern.trim()) {
    throw new Error(`[cron] pattern is required for "${name}"`);
  }
  if (registeredCrons.some((c) => c.name === name)) {
    throw new Error(
      `[cron] duplicate cron name "${name}" — each cron must have a unique name`,
    );
  }
  const entry: CronEntry = { name, pattern, handler, options };
  registeredCrons.push(entry);
  return entry;
}
