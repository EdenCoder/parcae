# `@parcae/analytics`

The analytics package adds an event-stream + rollup data model on top of Parcae's core, plus a deterministic detector pipeline and a typed-payload contract base for page-shaped read endpoints. The framework owns its own tables (auto-DDLed at boot) — no model rows for definitions. Metrics, detectors, matviews, and contracts are TypeScript classes that register in in-memory registries at module load. The package is SDK-agnostic: the only LLM touch point (`StoryComposer`) takes a caller-supplied completion function, so nothing here imports an AI SDK or hardcodes a model name.

## Schema

Three tables are auto-DDLed via `installAnalytics(db)` (which calls `ensureAnalyticsTables(db)`) at app start. A fourth — `analytics_story` — is created lazily by `ensureStoryTable()` / `runProjection()`. Safe non-key columns are repaired additively; a pre-existing table missing identity or conflict-key columns, or a valid unique index/constraint for an `ON CONFLICT` target, fails startup and requires an explicit versioned migration. All DDL for the first three lives in `schema.ts` (`analytics_event`, `analytics_snapshot`) and `state-change.ts` (`analytics_state_change`); story DDL lives in `story.ts`.

| Table                   | DDL by                  | Purpose                                                                                            |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| `analytics_event`       | `ensureAnalyticsTables` | Append-only fact stream. One row per real-world event (activity logged, nudge dispatched, etc.).  |
| `analytics_snapshot`    | `ensureAnalyticsTables` | Rollup table. One row per `(org, metricKey, grain, periodStart, dimensions)` via canonical-JSON dimension key. |
| `analytics_state_change`| `ensureAnalyticsTables` | Append-only cohort transition stream (`entered` / `left`). Idempotent re-runs.                     |
| `analytics_story`       | `ensureStoryTable` (lazy) | Localized insight rows. Replace-on-rerun by `(org, locale, periodEnd)`.                           |

`installAnalytics(db)` is idempotent: it ensures the three tables and installs the default Knex emitter (`createKnexEmitter`) via `setEventEmitter`. `ensureAnalyticsTables(db)` only patches safe additive columns. For existing snapshot and state-change tables it verifies the exact conflict targets against PostgreSQL's valid, immediate, non-partial unique indexes (including indexes backing unique constraints). It never fills missing IDs or conflict keys with shared defaults and never reconstructs primary/unique constraints on unknown legacy data; resolve duplicates and add the target in a versioned migration.

Indexes:
- events: `(org, key, occurredAt DESC)` and `(org, subject, occurredAt DESC)`
- snapshots: unique `(org, metricKey, grain, periodStart, dimensions)` plus lookup `(org, metricKey, grain, periodStart DESC)`
- state changes: `(org, subject, occurredAt DESC)`, `(org, cohort, occurredAt DESC)`, unique `(org, subject, cohort, sourceSnapshotId, transition)`
- stories: `(org, locale, periodEnd DESC)`

## Period

Windowing math, DST-safe. A `Period` is a half-open `[start, end)` plus a `grain` (`"day" | "week" | "month"`).

```ts
import { Period } from "@parcae/analytics";

const last28 = Period.last("28d");          // ends now
const last7 = Period.last("7d", asOf);      // ends at asOf
const custom = Period.last({ days: 14 });   // object form: { days?, weeks?, months? }
const prev = last28.previous();             // same-length window ending where last28 starts
last28.toSqlInterval();                     // "28 days"
last28.bucketCount();                       // number of grain buckets
last28.grain;                               // "day" | "week" | "month"
```

`Period.last(spec, now?)` accepts the spec strings `"7d" | "28d" | "12w" | "qtd" | "all"` or an object `{ days?, weeks?, months? }`. `"all"` returns `[epoch, now)` with grain `"week"`; `toSqlInterval()` returns `"infinity"` for an epoch start so callers can branch. The constructor throws `RangeError` if `end <= start`.

Static helpers: `Period.startOfDay(d)` (UTC midnight) and `Period.startOfWeek(d)` (UTC Monday) — the canonical normalisations for snapshot keys.

## ActivityEvent + `metric.event()` decorator

Hooks decorated with `metric.event()` capture into `analytics_event` declaratively. The decorator registers an after-hook with `{ async: true, priority: 200 }` so patient flows aren't blocked.

```ts
import { metric, ActivityEvent } from "@parcae/analytics";

// Typed view over an analytics_event row. Subclass to attach a typed
// dimensions shape and (optionally) a closed key vocabulary.
interface PatientDims {
  activityType?: string;
  source?: string;
}
class PatientActivityEvent extends ActivityEvent<PatientDims> {
  // Override accepts() to restrict the vocabulary. Default accepts ALL keys.
  static accepts(key: string): boolean {
    return ["activity.logged", "meal.logged", "nudge.responded"].includes(key);
  }
}

// Read typed instances back out of analytics_event:
const events = await PatientActivityEvent.query(db, {
  org,
  subject: patientId,
  since,
  limit: 100,
});
```

`ActivityEvent.query(db, q?)` filters by `org`, `subject` (string | string[]), `key` (string | string[]), `since` (`>=`), `until` (`<`), `limit`, orders `occurredAt DESC`, then drops rows the subclass's `static accepts(key)` rejects. There is **no** `static keys` / `static dimensions` field, and the base does not gate inserts — `accepts()` is a read-side filter only.

Decorate the lifecycle hook (e.g. Freia's `services/analytics/events.ts`):

```ts
metric.event(Activity, {
  key: "activity.logged",
  org: (m) => m.org,                                   // REQUIRED — throws at emit if absent
  subject: (m) => m.$patient,                          // defaults to $patient / $user
  dimensions: (m) => ({ activityType: m.activityType, source: m.source }),
});

metric.event(Nudge, {
  key: "nudge.dispatched",
  org: (m) => m.org,
  subject: (m) => m.$patient,
  when: (m, ctx) => isDispatched(m),                   // predicate gates emission; may be async
  on: ["create", "update"],                            // lifecycle actions; default ["create"]
});
```

`EventCaptureSpec` fields: `key` (required), `org` (required `(m) => string`), `subject?`, `occurredAt?` (defaults to `model.createdAt` then `now`), `source?` (`EventSource` or `(m) => EventSource`, default `"system"`), `dimensions?`, `when?` (`(m, ctx) => boolean | Promise<boolean>`, return `false` to drop), `on?` (default `["create"]`, also accepts `"save" | "update" | "patch"`).

- **`org` is mandatory.** It is called at emit time as `spec.org(model)`; if you omit it the handler throws. `analytics_event` is org-scoped.
- **`subject` defaults** to the model's `$patient` / `patient` id, then `$user` / `user` id; if neither resolves and you didn't supply `subject`, emit throws.
- **`dimensions` are capped at 4KB** (`MAX_DIMENSIONS_BYTES = 4 * 1024`). The decorator throws on overflow at emit time. Keep them small and never PHI text.

The default emitter is a per-emit Knex INSERT (`createKnexEmitter`). `setEventEmitter(custom)` is the swap point (e.g. a BullMQ-backed batched emitter). `getEventEmitter()` reads the active one; if none is set, emit is a silent no-op.

## Metric base

Query-driven rollups that read from `analytics_event` (or any source SQL) and write to `analytics_snapshot`.

```ts
import { Metric, registerMetric, type MetricContext, type MetricSnapshot } from "@parcae/analytics";

class WauMetric extends Metric {
  readonly key = "engagement.wau";
  readonly name = "Weekly active users";          // optional display name
  readonly grain = "week" as const;               // default "week"
  // readonly version = 1;                         // default 1; bump to invalidate older rows

  async compute(ctx: MetricContext): Promise<MetricSnapshot[]> {
    const since = new Date(ctx.period.end.getTime() - 7 * 24 * 60 * 60 * 1000);
    const { rows } = await ctx.db.raw(
      `SELECT COUNT(DISTINCT subject)::int AS active,
              COALESCE(ARRAY_AGG(DISTINCT subject), '{}') AS active_ids
         FROM analytics_event
        WHERE org = ? AND "occurredAt" >= ?`,
      [ctx.org, since],
    );
    const row = rows[0] ?? { active: 0, active_ids: [] };
    return [{
      value: row.active,
      // metadata.cohorts.<field>: persist subject ids alongside the count
      // so the drill-down dialog reads from the SAME run that produced
      // the count. Card and modal cannot disagree.
      metadata: { cohorts: { active7d: row.active_ids } },
    }];
  }
}

registerMetric(new WauMetric());
```

`MetricContext` is `{ org, period, db, now }`. `MetricSnapshot` is `{ value, dimensions?, metadata? }`.

Run them: `runMetric(metric, ctx)` for one, or `runMetrics(listMetrics(), ctx)` which runs metrics in parallel (`Promise.all`). Snapshot writes are scoped per `(org, metricKey)` so per-metric runs are independent. Both persist via the canonical upsert on `(org, metricKey, grain, periodStart, dimensions)`, merging `value, metadata, metricVersion, computedAt, periodEnd` on conflict, and return `PersistedSnapshot[]`.

`registerMetric` throws on a duplicate `key`. `getMetric(key)`, `listMetrics()`, `clearMetrics()` round out the registry. **No `metrics` DB table** — definitions live in TypeScript and register at module load.

Snapshot reads: `readLatestSnapshot(db, org, key, grain, dimensions?)` and `readSnapshotSeries(db, org, key, grain, period, dimensions?)`. Both default `dimensions` to `{}` and look up via `canonicalDimensions(dimensions)`.

**`metadata` is capped at 1MB** (a mutable module-level limit, default `1024 * 1024`). `persistSnapshots` throws if a snapshot's metadata exceeds it. Override with `setMaxMetadataBytes(bytes)` (throws on non-positive); read via `getMaxMetadataBytes()`. Realistic cohort-with-evidence payloads run hundreds of KB and are fine — the cap is a runaway guard, not a budget.

## Materialized views

Heavy multi-source aggregates the hot read path can't compute per-request.

```ts
import { defineMatview, refreshAll } from "@parcae/analytics";

defineMatview({
  name: "analytics_cohort_retention",
  uniqueColumns: ["org", "cohort_week", "weeks_after"],   // required for CONCURRENTLY
  sql: `
    WITH welcomed AS (...)
    SELECT w.org, ..., COUNT(DISTINCT ae.subject) AS retained
      FROM welcomed w
      ...
  `,
});

await refreshAll(db);   // CONCURRENTLY by default; isolates failures per matview
```

`defineMatview` throws if the name is already registered or `uniqueColumns` is empty (the unique index is required for `REFRESH MATERIALIZED VIEW CONCURRENTLY`). `ensureMatview(db, spec)` / `ensureAllMatviews(db)` create the view + unique index on first touch. `refreshMatview(db, name, { concurrently? })` refreshes one; `refreshAll(db, opts?)` refreshes all, catches errors per-matview, and returns `RefreshOutcome[]` (`{ name, ok, startedAt, finishedAt, error? }`) the scheduler can log. Registry helpers: `listMatviews()`, `clearMatviews()`.

## Detector + Finding + StoryComposer + projection

Replaces a single big-LLM-prompt approach with deterministic detectors plus small scoped composer calls. Two passes: atomic (raw data → atomic findings) and meta (findings → meta-findings). Both use the same `Finding` shape and the same composer.

```ts
import { Detector, registerDetector, type DetectorContext, type Finding } from "@parcae/analytics";

class CohortComparisonDetector extends Detector {
  readonly key = "cohort.retention_improvement";
  readonly input = "data" as const;          // pass 1 (default)

  async detect(ctx: DetectorContext): Promise<Finding[]> {
    // Read analytics_event / analytics_snapshot, return Finding[]
    return [{
      key: `cohort.retention_improvement.${cohortName}`,
      severity: "info",                       // "info" | "watch" | "action"
      data: { cohort: cohortName, lift: 7.2 },
      subjects: improvedPatientIds,           // required, not optional
      narrativeSeed: `${cohortName} retains 7pts better than the org average`,
      relatedMetrics: ["retention.cohort_curve"],  // required (may be [])
      scope: "outcome",                       // optional, for meta clustering
    }];
  }
}

class OnboardingMomentumDetector extends Detector {
  readonly key = "meta.onboarding_momentum";
  readonly input = "findings" as const;       // pass 2

  async detect(ctx: DetectorContext, findings?: Finding[]): Promise<Finding[]> {
    const onboarding = (findings ?? []).filter(f => f.scope === "onboarding");
    if (onboarding.length < 3) return [];
    return [{ /* ...,*/ sourceFindings: onboarding }];   // Finding[] attribution
  }
}

registerDetector(new CohortComparisonDetector());
```

`DetectorContext` is `{ org, period, db, now }`. `Detector.input` is `"data"` (default, pass 1) or `"findings"` (pass 2). `runDetectors(ctx)` runs all pass-1 detectors in parallel, then feeds their flattened output to all pass-2 detectors, and returns the union. A detector that throws is logged and contributes `[]` (failures isolated). Registry: `registerDetector`, `listDetectors(input?)`, `clearDetectors()`.

`Finding` fields: `key`, `severity`, `data` (the only thing handed to the composer), `subjects` (required `string[]`), `narrativeSeed`, `relatedMetrics` (required `string[]`), `scope?`, `sourceFindings?` (`Finding[]`, set when a meta-detector emits). Note: the **in-memory** `Finding` carries `sourceFindings: Finding[]`; the **persisted** story row carries `sourceFindingKeys: string[]` (derived from `sourceFindings.map(f => f.key)`).

### Composer

One scoped LLM call per finding. SDK-agnostic — you supply the completion function.

```ts
import { StoryComposer, type CompletionFn } from "@parcae/analytics";

const complete: CompletionFn = async ({ systemPrompt, userPrompt, jsonMode }) => {
  // Call whatever SDK you use; return the model's JSON.
  const json = await callYourModel({ systemPrompt, userPrompt, jsonMode });
  return { json };
};

const composer = new StoryComposer({ complete });
// Optional: override the baked-in clinician-tone brief.
// new StoryComposer({ complete, systemPrompt: "..." });
```

`ComposerOptions` is `{ complete: CompletionFn, systemPrompt? }`. `CompletionFn` takes `{ systemPrompt, userPrompt, jsonMode? }` and returns `Promise<{ json: unknown }>`. `systemPrompt` defaults to `DEFAULT_SYSTEM_PROMPT` (a clinician-tone brief baked into the module). There are no `primary` / `fallback` / `apiKey` / model-name options — the package never names a model or imports an AI SDK.

`composer.compose({ finding, maxBodyChars? })` sends the model ONLY `{ key, severity, data, narrativeSeed, relatedMetrics, cohortSize }` where `cohortSize = finding.subjects.length` (computed by the composer) — never a 40k-token fact table. It parses `{ title, body, quotedValues, metricRefs }` (throws on missing title/body), then clips `title` to 72 chars and `body` to `maxBodyChars` (default 600). Hallucination is mechanically harder.

`validateAgainstFinding(story, finding)` is the anti-hallucination gate: it throws if the prose cites a number not in the finding's `data` (within 0.05, plus numbers embedded in `relatedMetrics` keys like `journey.sustained_4w`) or claims a `metricRef` not in `finding.relatedMetrics`. The projection runner catches and drops on throw.

### Projection (deterministic)

```ts
import { runProjection } from "@parcae/analytics";

await runProjection({
  org,
  locale: "en",
  period,
  db,
  now,
  composer,        // optional — omit for a deterministic fallback (see below)
  maxStories: 6,   // optional, default 6
});
```

`runProjection(ctx)` takes a single `ProjectionContext` — that is `DetectorContext` (`{ org, period, db, now }`) plus required BCP 47 `locale` and optional `composer?` and `maxStories?` (default 6). It:

1. Runs `runDetectors(ctx)` to get findings.
2. If `composer` is present, composes + validates each finding in parallel (`Promise.allSettled`), dropping any that throw. **If `composer` is omitted, each finding becomes a deterministic `fallbackStory`** built from `narrativeSeed` (title = first 72 chars, body = the seed, `quotedValues = []`, `metricRefs = relatedMetrics`) — no LLM call.
3. Ranks (`severity × 10` + `+100` meta boost when `sourceFindings` is set + cohort size clamped to 50), dedupes by lowercased title, and caps at `maxStories`.
4. Promotes the highest-ranked `action`-severity story to `status: "priority"` (at most one).
5. Persists under a transaction advisory lock whose `(org, locale, periodEnd)` identity is JSON-encoded, then replaces rows for that exact identity. A real-locale write also removes legacy `locale = "und"` rows for only the same org and period.

## Story shape

`StoryRow` columns written by the projection (`STORY_TABLE = "analytics_story"`):

| Column                | Notes                                                                            |
| --------------------- | -------------------------------------------------------------------------------- |
| `locale`              | BCP 47 locale of the generated prose; part of the replacement identity.          |
| `key`                 | Hierarchical, from the source finding, e.g. `meta.onboarding_momentum`.          |
| `status`              | `priority` / `working` / `slipping` / `watching` / `ready_to_ship` (`StoryStatus`). |
| `severity`            | `info` / `watch` / `action`. Drives visual weight.                               |
| `title` / `body`      | Composed prose. Clipped to ≤72 / ≤600 chars.                                     |
| `rank`                | Higher = higher in the strip (assigned `stories.length - i` on insert).          |
| `subjects`            | Patient ids — the drill-down list (JSONB).                                       |
| `data`                | Echo of the finding's structured payload (anti-hallucination input).            |
| `metricRefs`          | Validator allow-list — body only cites metrics in this list.                     |
| `quotedValues`        | Validator allow-list — body only cites numbers in this list.                     |
| `modelName`           | `"meta-detector"` when the finding had `sourceFindings`, else `"atomic-detector"`. |
| `sourceFindingKeys`   | `string[]` of source finding keys; empty for atomic stories.                     |
| `periodEnd`           | Replace key with `org` and `locale`; same-period reruns replace cleanly.         |

`deriveStatus(finding)`: `action` → `slipping`; key contains `"ready"` → `ready_to_ship`; key contains `"improvement"` → `working`; otherwise `watching`. The single `action` promotion then overrides one row to `priority`.

## State changes

`analytics_state_change` captures cohort transitions (`entered` / `left`) emitted by metric runs — powering "entered slipping 3d ago" lines, a top-movers panel, and "just dropped off" derived cohorts.

```ts
import { diffCohorts, persistStateChangeRows } from "@parcae/analytics";

// 1. pure diff (no DB writes)
const rows = diffCohorts({
  org,
  metricKey: "engagement.wau",
  sourceSnapshotId,             // id of the new snapshot row
  previousSnapshotId,           // id of the prior snapshot, or null on first run
  occurredAt: now,
  priorCohorts: prior.metadata.cohorts ?? {},   // Record<string, string[]>
  newCohorts: next.metadata.cohorts ?? {},
  cohortReasons,                // optional Record<string, Record<string, ReasonShape[]>>
});

// 2. persist inside the same transaction as the snapshot write
await persistStateChangeRows(trx, rows);
```

`diffCohorts(args: DiffArgs)` is pure. The diff is per-cohort field: a subject can `enter` cohort A and `leave` cohort B in the same run. A cohort present in only `priorCohorts` or only `newCohorts` produces a one-sided diff. First run (`previousSnapshotId = null`, empty `priorCohorts`) emits `entered` for everyone. `entered` rows can carry `reasonCode` / `reason` from `cohortReasons.<field>.<subject>[0]` (a `ReasonShape` `{ code, label }`); `left` rows always carry `null` reasons.

`persistStateChangeRows(db, rows)` does `INSERT ... ON CONFLICT DO NOTHING` on the unique index `(org, subject, cohort, sourceSnapshotId, transition)`, so re-running the diff against the same source snapshot is a no-op. It opens no transaction of its own — pass a `Knex.Transaction` to keep snapshot + diff writes atomic. `StateChangeRow.transition` is `"entered" | "left"` (`Transition`).

## Contract base

Page-shaped read endpoints. The frontend hits a single URL and gets back a typed JSON object that contains everything the visible surface needs.

```ts
import { Contract, mountContract, type ContractContext } from "@parcae/analytics";

class ClinicDashboardContract extends Contract<DashboardPayload> {
  readonly path = "/v1/analytics/clinic-dashboard";
  readonly metrics = ["engagement.wau", "behaviour.coverage_meal"];   // for freshness

  async data(ctx: ContractContext): Promise<DashboardPayload> {
    return { kpis: ..., trends: ..., breakdowns: ... };
  }
}

mountContract(app, new ClinicDashboardContract(), {
  db,
  parsePeriod: (spec) => Period.last(spec as "28d"),
  guard: (req) => (req.session?.user?.role === "admin" ? undefined : "admin only"),
});
```

`mountContract(app, contract, opts: MountOptions)` wires the contract into a Polka-like instance (`app.get(path, handler)`). `MountOptions` includes `{ db, parsePeriod, guard?, authorizeOrg? }`:
- `parsePeriod(spec: string) => Period` — turns the `?period=` string into a `Period`.
- `guard?: ContractGuard` — `(req) => string | { error, status? } | undefined`. **Any** string denies with 403 (including `""`, which yields an empty error body); an object denies with its `status` (default 403). Return `undefined` (or a non-string falsy) to allow — note `""` does **not** allow.
- `authorizeOrg?: ContractOrgAuthorizer` — required when the final resolved `ctx.org` differs from the authenticated session org.

The handler calls `contract.resolveContext(req, db, parsePeriod)`, authorizes the final `ctx.org`, then runs `data()` and `freshness()` in parallel and responds `{ data, freshness }` (`ContractResponse<T>`). Authorization happens after overrides, so a custom `resolveContext()` cannot bypass tenant checks. On a thrown `ContractError` it responds with that error's `status`; any other error → 500.

`resolveContext` (overridable) reads `?org=` (falling back to `req.session?.orgId`) and `?period=` (default `"28d"`), and throws `ContractError(400, "missing org")` if no org resolves. `ContractContext` is `{ org, period, db, now, req }`.

`freshness(ctx)` derives `{ asOf, byMetric }` from the most recent `analytics_snapshot.computedAt` across `contract.metrics`; returns `{ asOf: null, byMetric: {} }` when `metrics` is empty.

If the host app owns its own router + auth, skip `mountContract` and call `contract.data(ctx)` / `contract.freshness(ctx)` directly under your own middleware.

## Drill-down convention

When a tile shows a count and the user clicks to see the patients behind it, the patient ids MUST come from the same SQL run that produced the count.

1. Metric run persists the patient-id array on `MetricSnapshot.metadata.cohorts.<field>`.
2. App-level registry (e.g. `METRIC_BACKED_COHORTS`) maps slug → `{ metricKey, field }`.
3. Drill-down handler reads `analytics_snapshot.metadata.cohorts.<field>`, looking up the snapshot via `canonicalDimensions({})` for the default-dimensions row.

## File map

```
packages/analytics/src/
  period.ts          # Period + spec parsing (string + { days, weeks, months })
  event.ts           # metric.event() decorator, AnalyticsEvent, EventCaptureSpec, emitter swap
  metric.ts          # Metric base + canonical snapshot upsert + readLatest/readSeries + metadata cap
  activity-event.ts  # ActivityEvent<Dims> typed view + static accepts() + query()
  contract.ts        # Contract base + mountContract() + MountOptions + ContractError
  matview.ts         # defineMatview() + refreshAll()/ensureAllMatviews() + RefreshOutcome
  finding.ts         # Detector base + Finding shape + runDetectors()
  composer.ts        # StoryComposer (CompletionFn wrapper) + validateAgainstFinding
  story.ts           # StoryRow + ensureStoryTable + runProjection + deriveStatus
  state-change.ts    # diffCohorts() + persistStateChangeRows() + ensureStateChangeTable
  schema.ts          # installAnalytics/ensureAnalyticsTables, table constants, canonicalDimensions, createKnexEmitter
  schema-upgrade.ts  # safe additive-column repair + structural fail-loud checks
  examples.ts        # WauMetric + AnomalyDetector reference implementations
  id.ts              # generateId (re-export of @parcae/model)
  index.ts           # Public exports
```

## Pitfalls

- **Knex `IN (?)` does NOT auto-expand arrays.** Build placeholders dynamically: `keys.map(() => "?").join(",")`. (`ActivityEvent.query` uses `whereIn`, which is safe.)
- **JSONB `?` operator collides with knex bindings.** Use `jsonb_exists(col, 'key')` instead of `col ? 'key'`.
- **`canonicalDimensions(d)` is the JSONB sort key.** Same-shape rows fragment if you skip it. Snapshot upsert + reads + drill-down all pass `canonicalDimensions({})` for default-dimensions rows.
- **JSONB columns aren't auto-stringified by the pg driver.** The story persist path `JSON.stringify`s every JSON column explicitly before insert; do the same in custom write paths.
- **No content scanning on chat / note bodies.** Privacy posture — read `length(content)`, `count(*)`, role enums, JSONB structural containment only.
- **Welcomed-patient gate** on every "active panel" denominator: `WHERE patient.welcomeEmailSentAt IS NOT NULL`. Without it, prospect rows pull every "% of patients" rate toward zero.
