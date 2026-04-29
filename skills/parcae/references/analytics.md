# `@parcae/analytics`

The analytics package adds an event-stream + rollup data model on top of Parcae's core, plus a deterministic detector pipeline and a typed-payload contract base for page-shaped read endpoints. Two tables, no model rows. Everything else (metrics, detectors, contracts) is TypeScript classes that self-register at module load.

## Schema

Two tables, auto-DDLed via `installAnalytics(db)` at app start. Never write a migration for them.

| Table                | Purpose                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `analytics_event`    | Append-only fact stream. One row per real-world event (activity logged, nudge dispatched, etc.).              |
| `analytics_snapshot` | Rollup table. One row per `(org, metricKey, grain, periodStart, dimensions)` via canonical-JSON dimension key. |
| `analytics_story`    | Composed insight rows. Replace-on-rerun by `(org, periodEnd)`.                                                |

Indexed `(org, key, occurredAt)` and `(org, subject, occurredAt)` on events; `(org, metricKey, grain, periodStart DESC)` on snapshots; `(org, periodEnd DESC)` on stories.

## Period

Windowing math, DST-safe.

```ts
import { Period } from "@parcae/analytics";

const last28 = Period.last("28d");        // ends now
const last7 = Period.last("7d", asOf);    // ends at asOf
const prev = last28.previous();           // 28d before last28
last28.toSqlInterval();                   // "28 days"
last28.grain                              // "day" | "week" | "month"
```

Accepts the spec strings `"7d" | "28d" | "12w" | "qtd" | "all"`.

## ActivityEvent + `@metric.event()` decorator

Hooks decorated with `metric.event()` capture into `analytics_event` declaratively. Parcae registers an after-hook with `async: true, priority: 200` so patient flows aren't blocked.

```ts
// Define a typed event subclass — types travel through the system
class PatientActivityEvent extends ActivityEvent {
  static keys = ["activity.logged", "meal.logged", "nudge.responded"] as const;
  static dimensions: Record<string, Record<string, string | undefined>>;
}

// Decorate the hook (Freia's services/analytics/events.ts):
metric.event(Activity, {
  key: "activity.logged",
  subject: (m) => m.$patient,
  dimensions: (m) => ({ activityType: m.activityType, source: m.source }),
});

metric.event(Nudge, {
  key: "nudge.dispatched",
  subject: (m) => m.$patient,
  when: (m) => isDispatched(m),    // Predicate gates the event emission
});
```

Closed key vocabulary — adding a new key requires updating the subclass's `keys` first; otherwise the model's `query()` won't admit it.

The default emitter is per-emit Knex INSERT. `setEventEmitter(custom)` is the swap point; a BullMQ-backed batched emitter is a deferred follow-up.

## Metric base

Query-driven rollups that read from `analytics_event` (or any source SQL) and write to `analytics_snapshot`.

```ts
class WauMetric extends Metric {
  readonly key = "engagement.wau";
  readonly name = "Weekly Active Users";
  readonly grain = "week" as const;

  async compute(ctx: MetricContext): Promise<MetricSnapshot[]> {
    const since = new Date(ctx.now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const { rows } = await ctx.db.raw(
      `SELECT subject FROM analytics_event ae
        WHERE ae.org = ? AND ae."occurredAt" >= ? GROUP BY subject`,
      [ctx.org, since],
    );
    return [{
      value: rows.length,
      // metadata.cohorts.<field>: persist patient ids alongside the
      // count so the drill-down dialog reads from the SAME run that
      // produced the count. Card and modal cannot disagree.
      metadata: { cohorts: { active7d: rows.map(r => r.patient) } },
    }];
  }
}

registerMetric(new WauMetric());
```

Run them: `runMetrics(listMetrics(), ctx)` with `Promise.all` parallelism. Snapshot writes are scoped per `(org, metricKey)` so per-metric runs are independent.

**No `metrics` DB table** — definitions live in TypeScript, register at module load.

## Materialized views

Heavy multi-source aggregates the hot read path can't compute per-request.

```ts
defineMatview({
  name: "analytics_cohort_retention",
  uniqueColumns: ["org", "cohort_week", "weeks_after"],
  sql: `
    WITH welcomed AS (...)
    SELECT w.org, ..., COUNT(DISTINCT ae.subject) AS retained
      FROM welcomed w
      ...
  `,
});

await refreshAll(db);  // CONCURRENTLY refresh all defined matviews
```

The unique-columns hint is required for `REFRESH MATERIALIZED VIEW CONCURRENTLY`. `refreshAll` isolates failures per matview so one broken view doesn't stop the others.

## Detector + Finding + StoryComposer + projection

Replaces a single big-LLM-prompt approach with deterministic detectors plus small scoped composer calls. Two passes: atomic (raw data → atomic findings) and meta (findings → meta-findings).

```ts
class CohortComparisonDetector extends Detector {
  readonly key = "cohort.retention_improvement";
  readonly input = "data" as const;          // pass 1

  async detect(ctx: DetectorContext): Promise<Finding[]> {
    // Read analytics_event / analytics_snapshot, return Finding[]
    return [{
      key: `cohort.retention_improvement.${cohortName}`,
      severity: "info",
      data: { cohort: cohortName, lift: 7.2 },
      subjects: improvedPatientIds,
      narrativeSeed: `${cohortName} retains 7pts better than the org average`,
      relatedMetrics: ["retention.cohort_curve"],
      scope: "outcome",
    }];
  }
}

class OnboardingMomentumDetector extends Detector {
  readonly key = "meta.onboarding_momentum";
  readonly input = "findings" as const;      // pass 2

  async detect(ctx: DetectorContext, findings: Finding[]): Promise<Finding[]> {
    const onboarding = findings.filter(f => f.scope === "onboarding");
    if (onboarding.length < 3) return [];
    return [{ ... sourceFindings: onboarding }];
  }
}
```

Composer (one scoped LLM call per finding):

```ts
const composer = new StoryComposer({
  primary: "anthropic/claude-sonnet-4-5",
  fallback: "anthropic/claude-haiku-4-5",
  apiKey: env.OPENROUTER_KEY,
});
```

The composer ONLY sees one finding's structured `data` + `relatedMetrics` + `cohortSize` — never a 40k-token fact table. Hallucination is mechanically harder.

Projection (deterministic):

```ts
await runProjection({
  org,
  period,
  db,
  now,
  composer,
  maxStories: 6,
});
```

Validates each composed story against its source finding (drop on hallucinated metric ref or quoted number — anti-hallucination gate). Ranks by severity + meta-vs-atomic boost + cohort size. Caps at 6 stories per run with at most one `priority` story. Persists by deleting prior rows for the same `(org, periodEnd)` first.

## Story shape

Subclass-friendly base; columns the projection writes:

| Column                | Notes                                                                         |
| --------------------- | ----------------------------------------------------------------------------- |
| `key`                 | Hierarchical, e.g. `meta.outcome_translation`.                                |
| `status`              | `priority` / `working` / `slipping` / `watching` / `ready_to_ship`.           |
| `severity`            | `info` / `watch` / `action`. Drives visual weight.                            |
| `title` / `body`      | Composed prose. ≤72 / ≤600 chars.                                             |
| `subjects`            | Named patient ids — the drill-down list.                                      |
| `data`                | Echo of the finding's structured payload (anti-hallucination input).          |
| `metricRefs`          | Validator allow-list — body must only cite metrics in this list.              |
| `quotedValues`        | Validator allow-list — body must only cite numbers in this list.              |
| `sourceFindingKeys`   | Empty for atomic stories; populated for meta.                                 |
| `rank`                | Higher = higher in the strip.                                                 |
| `periodEnd`           | UPSERT key — same-day reruns replace cleanly.                                 |

## Contract base

Page-shaped read endpoints. The frontend hits a single URL and gets back a typed JSON object that contains everything the visible surface needs.

```ts
class ClinicDashboardContract extends Contract<DashboardPayload> {
  readonly path = "/v1/analytics/clinic-dashboard";
  readonly metrics: string[] = ["engagement.wau", "behaviour.coverage_meal"];

  async data(ctx: ContractContext): Promise<DashboardPayload> {
    return { kpis: ..., trends: ..., breakdowns: ... };
  }
}
```

`mountContract(app, contract, opts)` wires it into a Polka instance. Or, if the host app owns its own routing layer + auth middleware, register via `route.get(contract.path, ...)` directly:

```ts
route.get(contract.path, requireAdmin, async (req, res) => {
  const ctx = { org, period, db, now, req };
  const [data, freshness] = await Promise.all([
    contract.data(ctx),
    contract.freshness(ctx),
  ]);
  ok(res, { data, freshness });
});
```

Freshness is auto-derived from the most recent `computedAt` across the contract's `metrics`.

## Drill-down convention

When a tile shows a count and the user clicks to see the patients behind it, the patient ids MUST come from the same SQL run that produced the count.

1. Metric run persists patient-id array on `MetricSnapshot.metadata.cohorts.<field>`.
2. App-level `METRIC_BACKED_COHORTS` registers slug → `{ metricKey, field }`.
3. Drill-down handler reads `analytics_snapshot.metadata.cohorts.<field>` directly via `canonicalDimensions({})`.

## Critical files

```
submodules/parcae/packages/analytics/src/
  period.ts                  # Period + spec parsing
  event.ts                   # @metric.event() decorator + analytics_event schema
  metric.ts                  # Metric base + analytics_snapshot upsert
  activity-event.ts          # ActivityEvent typed-row base
  contract.ts                # Contract base + mountContract()
  matview.ts                 # defineMatview() + refreshAll()
  finding.ts                 # Detector base + Finding shape + runDetectors()
  composer.ts                # StoryComposer (ai-sdk wrapper) + validateAgainstFinding
  story.ts                   # Story shape + ensureStoryTable + runProjection
  schema.ts                  # ANALYTICS_EVENT_TABLE / ANALYTICS_SNAPSHOT_TABLE constants
  index.ts                   # Public exports
```

## Pitfalls

- **Knex `IN (?)` does NOT auto-expand arrays.** Build placeholders dynamically: `keys.map(() => "?").join(",")`.
- **JSONB `?` operator collides with knex bindings.** Use `jsonb_exists(col, 'key')` instead of `col ? 'key'`.
- **`canonicalDimensions(d)` is the JSONB sort key.** Same-shape rows fragment if you skip it. Snapshot upsert + drill-down read both pass `canonicalDimensions({})` for default-dimensions rows.
- **No content scanning on chat / note bodies.** Privacy posture — read `length(content)`, `count(*)`, role enums, JSONB structural containment only.
- **Welcomed-patient gate** on every "active panel" denominator: `WHERE patient.welcomeEmailSentAt IS NOT NULL`. Without it, prospect rows pull every "% of patients" rate toward zero.
