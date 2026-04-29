/**
 * @parcae/analytics — Reference implementations
 *
 * `WauMetric` and `AnomalyDetector` are shipped as the canonical
 * end-to-end smoke. Freia ports its real metrics in P1; these stay in
 * the package as the "what does a Metric look like" reference and as
 * fixtures for the integration test.
 */

import { Metric, type MetricContext, type MetricSnapshot } from "./metric.js";
import {
  Detector,
  type DetectorContext,
  type Finding,
} from "./finding.js";
import { ANALYTICS_EVENT_TABLE } from "./schema.js";
import {
  ANALYTICS_SNAPSHOT_TABLE,
  canonicalDimensions,
} from "./schema.js";
import { Period } from "./period.js";

/**
 * Weekly active users. The canonical event-stream metric: distinct
 * subjects with any event in the last 7 days.
 */
export class WauMetric extends Metric {
  readonly key = "engagement.wau";
  readonly name = "Weekly active users";
  readonly grain = "week" as const;

  async compute(ctx: MetricContext): Promise<MetricSnapshot[]> {
    const since = new Date(ctx.period.end.getTime() - 7 * 24 * 60 * 60 * 1000);
    const { rows } = (await ctx.db.raw(
      `SELECT
         COUNT(DISTINCT subject)::int  AS active,
         COALESCE(ARRAY_AGG(DISTINCT subject), '{}') AS active_ids
       FROM ${ANALYTICS_EVENT_TABLE}
       WHERE org = ? AND "occurredAt" >= ?`,
      [ctx.org, since],
    )) as { rows: Array<{ active: number; active_ids: string[] }> };
    const row = rows[0] ?? { active: 0, active_ids: [] };
    return [
      {
        value: row.active,
        metadata: { cohorts: { active7d: row.active_ids } },
      },
    ];
  }
}

/**
 * Median + MAD anomaly detector. Reads `analytics_snapshot` series
 * for a configured set of metric keys, flags weeks where the latest
 * value is more than `madThreshold` × σ-equivalent from the rolling
 * median.
 *
 * MAD-based, not mean+std — the codebase's series aren't normally
 * distributed, and mean+std mis-fires on count-shaped data.
 */
export class AnomalyDetector extends Detector {
  readonly key = "anomaly";
  readonly input = "data" as const;

  constructor(
    private readonly metricKeys: string[],
    private readonly opts: { minSeries?: number; watchZ?: number; actionZ?: number } = {},
  ) {
    super();
  }

  async detect(ctx: DetectorContext): Promise<Finding[]> {
    const minSeries = this.opts.minSeries ?? 8;
    const watchZ = this.opts.watchZ ?? 3;
    const actionZ = this.opts.actionZ ?? 4.5;
    const out: Finding[] = [];

    for (const metricKey of this.metricKeys) {
      const series = await readSeries(ctx, metricKey);
      if (series.length < minSeries) continue;

      const latest = series[series.length - 1];
      if (!latest) continue;
      const baseline = series.slice(-7, -1);
      const baselineValues = baseline.map((s) => s.value);
      const median = percentile(baselineValues, 0.5);
      const mad = medianAbsDeviation(baselineValues, median);
      const sigma = 1.4826 * mad;
      const latestValue = latest.value;

      if (sigma === 0) {
        if (latestValue !== median) {
          out.push({
            key: `anomaly.step_change.${metricKey}`,
            severity: "watch",
            data: {
              metricKey,
              latest: latestValue,
              baseline: median,
              baselineWeeks: baseline.length,
            },
            subjects: [],
            narrativeSeed: `${metricKey} stepped from a flat baseline of ${median} to ${latestValue}`,
            relatedMetrics: [metricKey],
          });
        }
        continue;
      }

      const z = (latestValue - median) / sigma;
      const absZ = Math.abs(z);
      if (absZ < watchZ) continue;

      const severity: Finding["severity"] = absZ >= actionZ ? "action" : "watch";
      const direction = z > 0 ? "above" : "below";
      out.push({
        key: `anomaly.${direction}_baseline.${metricKey}`,
        severity,
        data: {
          metricKey,
          latest: latestValue,
          baselineMedian: median,
          robustZ: roundTo(z, 2),
          sigma: roundTo(sigma, 2),
        },
        subjects: [],
        narrativeSeed: `${metricKey} is ${direction} its 6-week baseline`,
        relatedMetrics: [metricKey],
      });
    }
    return out;
  }
}

async function readSeries(
  ctx: DetectorContext,
  metricKey: string,
): Promise<Array<{ periodStart: Date; value: number }>> {
  const rows = (await ctx.db(ANALYTICS_SNAPSHOT_TABLE)
    .where({
      org: ctx.org,
      metricKey,
      grain: "week",
      dimensions: canonicalDimensions({}),
    })
    .orderBy("periodStart", "asc")) as Array<{
    periodStart: Date;
    value: number;
  }>;
  return rows.map((r) => ({ periodStart: r.periodStart, value: Number(r.value) }));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? loVal;
  if (lo === hi) return loVal;
  return loVal + (hiVal - loVal) * (idx - lo);
}

function medianAbsDeviation(values: number[], median: number): number {
  const deviations = values.map((v) => Math.abs(v - median));
  return percentile(deviations, 0.5);
}

function roundTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export { Period };
