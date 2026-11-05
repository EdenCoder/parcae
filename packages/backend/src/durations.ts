/**
 * @parcae/backend — Durations
 *
 * One JSON line per finished route call or job delivery, appended to the
 * file PARCAE_DURATIONS names. One append per line lets the API and the
 * worker share the file.
 */

import { appendFileSync } from "node:fs";
import { log } from "./logger";

// ─── Line ────────────────────────────────────────────────────────────────────

interface Duration {
  kind: "route" | "job";
  name: string;
  startedAt: string;
  durationMs: number;
  status: number | "completed" | "failed";
  attempt?: number;
  enqueuedAt?: string;
}

// ─── Writers ─────────────────────────────────────────────────────────────────

/** Notes now; the function it returns appends the entry, timed from here. */
export function startDuration(): (
  entry: Omit<Duration, "startedAt" | "durationMs">,
) => void {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  return (entry) => {
    const file = process.env.PARCAE_DURATIONS;
    if (!file) return;
    const durationMs = Math.round(performance.now() - started);
    try {
      const line = JSON.stringify({ ...entry, startedAt, durationMs });
      appendFileSync(file, `${line}\n`);
    } catch (err) {
      log.warn("[durations] write failed:", err);
    }
  };
}

/** First step of the chain: writes one `route` line when the response ends. */
export function timeRequest(req: any, res: any, next: any): void {
  const finish = startDuration();
  const end = res.end;
  res.end = function (...args: any[]) {
    res.end = end;
    const out = end.apply(res, args);
    finish({
      kind: "route",
      name: `${req.method} ${req.route?.path ?? req.path}`,
      status: res.statusCode,
    });
    return out;
  };
  next();
}
