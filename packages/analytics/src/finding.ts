/**
 * @parcae/analytics — Finding + Detector
 *
 * Findings are the structured intermediate between a deterministic
 * detector (no LLM) and a small scoped composer call (LLM writes
 * prose). The composer only sees pre-validated structured data, never
 * a giant fact table — hallucination is mechanically harder.
 *
 * Detectors recurse: pass 1 takes raw `analytics_event` /
 * `analytics_snapshot` data and emits atomic findings; pass 2 takes
 * the atomic findings and emits meta-findings ("three signals point
 * to onboarding firing on multiple cylinders"). The same `Finding`
 * shape, the same composer, no new pipeline modes.
 */

import type { Knex } from "knex";
import type { Period } from "./period.js";

export type Severity = "info" | "watch" | "action";

export interface Finding {
  /** Hierarchical key identifying which detector fired, e.g. `"cohort.retention_improvement"`. */
  key: string;
  severity: Severity;
  /** Pre-validated structured data — only this gets passed to the composer. */
  data: Record<string, unknown>;
  /** Named patient ids in the cohort behind this finding. Required, not optional. */
  subjects: string[];
  /** Hint for the composer — short English phrase, not the final prose. */
  narrativeSeed: string;
  /** Metric keys this finding relates to. Used by the projection ranker. */
  relatedMetrics: string[];
  /** Optional scope tag for meta-detectors to cluster on, e.g. `"onboarding"`. */
  scope?: string;
  /** Source attribution — set automatically when a meta-detector emits. */
  sourceFindings?: Finding[];
}

export interface DetectorContext {
  org: string;
  period: Period;
  db: Knex;
  now: Date;
}

export type DetectorInput = "data" | "findings";

export abstract class Detector {
  abstract readonly key: string;
  /**
   * `"data"` (default) — pass 1, runs against raw analytics tables.
   * `"findings"` — pass 2, runs against the output of pass 1 detectors.
   */
  readonly input: DetectorInput = "data";

  abstract detect(ctx: DetectorContext, findings?: Finding[]): Promise<Finding[]>;
}

const registry: Detector[] = [];

export function registerDetector(d: Detector): void {
  registry.push(d);
}

export function listDetectors(input?: DetectorInput): Detector[] {
  if (!input) return [...registry];
  return registry.filter((d) => d.input === input);
}

export function clearDetectors(): void {
  registry.length = 0;
}

/**
 * Run all registered detectors in two passes. Returns the union of
 * atomic + meta findings. Caller (the projection runner) ranks /
 * dedupes / persists.
 */
export async function runDetectors(ctx: DetectorContext): Promise<Finding[]> {
  const atomic = await Promise.all(
    listDetectors("data").map((d) => safeRun(d, ctx)),
  );
  const flatAtomic = atomic.flat();
  const meta = await Promise.all(
    listDetectors("findings").map((d) => safeRun(d, ctx, flatAtomic)),
  );
  return [...flatAtomic, ...meta.flat()];
}

async function safeRun(
  d: Detector,
  ctx: DetectorContext,
  findings?: Finding[],
): Promise<Finding[]> {
  try {
    return await d.detect(ctx, findings);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[detector ${d.key}] failed: ${msg}`);
    return [];
  }
}
