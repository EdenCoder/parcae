/**
 * @parcae/analytics — state-transition stream
 *
 * Append-only `analytics_state_change` table that captures cohort
 * transitions emitted by metric runs. One row per `(subject, cohort,
 * transition)` per snapshot. Powers:
 *
 *   - "Recent" lines on per-patient story cards ("entered slipping 3d
 *     ago", "left needs review last week").
 *   - Top-movers panel — cohort transitions over a window without
 *     bespoke `audits.diff` SQL.
 *   - "Just dropped off this week" derived cohort.
 *
 * Idempotency. The unique index on `(org, subject, cohort,
 * sourceSnapshotId, transition)` plus `INSERT ... ON CONFLICT DO
 * NOTHING` means re-running the diff against the same source snapshot
 * is a no-op. Repeated metric runs (manual refresh button, retried
 * jobs, hourly schedule re-firing the same period) cannot produce
 * duplicate `entered` / `left` rows.
 *
 * Read-after-write safety. The diff is intentionally a pure function
 * (`diffCohorts`); the caller is responsible for sequencing the SELECT
 * (prior snapshot) → INSERT (new snapshot) → INSERT (diff rows) flow,
 * ideally inside one transaction. The diff never reads the snapshot it
 * just wrote — it sees `priorCohorts` and `newCohorts` as inputs.
 *
 * First run for a cohort emits `entered` rows for every subject with
 * `previousSnapshotId = null`.
 */

import type { Knex } from "knex";
import { generateId } from "./id.js";
import {
  assertUniqueConflictTarget,
  assertStructuralColumns,
  ensureAdditiveColumn,
} from "./schema-upgrade.js";

export const ANALYTICS_STATE_CHANGE_TABLE = "analytics_state_change";

export type Transition = "entered" | "left";

export interface StateChangeRow {
  id: string;
  org: string;
  /** Subject id — typically a patient id; whatever the metric tracks. */
  subject: string;
  /** Cohort field name — `metadata.cohorts.<cohort>` on the snapshot. */
  cohort: string;
  /** `entered` (was not in prior, is in new) or `left` (was in prior, not in new). */
  transition: Transition;
  /** When the transition was recorded. Caller picks; usually `ctx.now`. */
  occurredAt: Date;
  /** The metric whose run produced this transition. */
  metricKey: string;
  /** id of the new `analytics_snapshot` row that triggered this transition. */
  sourceSnapshotId: string;
  /** id of the prior snapshot we diffed against. `null` on first run. */
  previousSnapshotId: string | null;
  /**
   * Canonical reason code, when the new snapshot's
   * `metadata.cohortReasons.<cohort>.<subject>[0]` is populated.
   * `null` for `left` rows and for cohorts that don't carry reasons.
   */
  reasonCode: string | null;
  /** Human-readable reason snapshot, mirrors `reasonCode`. */
  reason: string | null;
}

/**
 * Minimal shape of an entry inside `metadata.cohortReasons.<cohort>.<subject>`.
 * The diff only reads `code` + `label` from the first entry; the full
 * `evidence` payload is not duplicated onto the state-change row.
 */
export interface ReasonShape {
  code: string;
  label: string;
}

export interface DiffArgs {
  org: string;
  metricKey: string;
  sourceSnapshotId: string;
  previousSnapshotId: string | null;
  occurredAt: Date;
  /**
   * `metadata.cohorts` of the prior snapshot. Empty `{}` when there's
   * no prior (first run for this metric+dimensions).
   */
  priorCohorts: Record<string, string[]>;
  /** `metadata.cohorts` of the new snapshot just written. */
  newCohorts: Record<string, string[]>;
  /**
   * Optional reasons map from `metadata.cohortReasons` on the new
   * snapshot. Used to populate `reasonCode` / `reason` on `entered`
   * rows. Cohorts missing from the map render with null reasons (legacy
   * behaviour preserved).
   */
  cohortReasons?: Record<string, Record<string, ReasonShape[]>>;
}

/**
 * Compute the entered/left rows for one metric run. Pure function — no
 * DB writes. Caller persists via `persistStateChangeRows()` inside its
 * transaction.
 *
 * Diff direction is per-cohort: a subject can `enter` cohort A and
 * simultaneously `leave` cohort B in the same run, and both rows are
 * emitted. Cohorts present in only one of `priorCohorts` /
 * `newCohorts` produce one-sided diffs (everyone entered / everyone
 * left).
 */
export function diffCohorts(args: DiffArgs): StateChangeRow[] {
  const rows: StateChangeRow[] = [];
  const fields = new Set<string>([
    ...Object.keys(args.priorCohorts),
    ...Object.keys(args.newCohorts),
  ]);
  for (const field of fields) {
    const prior = new Set(args.priorCohorts[field] ?? []);
    const next = new Set(args.newCohorts[field] ?? []);
    const reasons = args.cohortReasons?.[field] ?? {};
    for (const subject of next) {
      if (prior.has(subject)) continue;
      const reason = reasons[subject]?.[0];
      rows.push({
        id: generateId(),
        org: args.org,
        subject,
        cohort: field,
        transition: "entered",
        occurredAt: args.occurredAt,
        metricKey: args.metricKey,
        sourceSnapshotId: args.sourceSnapshotId,
        previousSnapshotId: args.previousSnapshotId,
        reasonCode: reason?.code ?? null,
        reason: reason?.label ?? null,
      });
    }
    for (const subject of prior) {
      if (next.has(subject)) continue;
      rows.push({
        id: generateId(),
        org: args.org,
        subject,
        cohort: field,
        transition: "left",
        occurredAt: args.occurredAt,
        metricKey: args.metricKey,
        sourceSnapshotId: args.sourceSnapshotId,
        previousSnapshotId: args.previousSnapshotId,
        // `left` rows carry no reason — the patient is exiting the
        // cohort, not entering it; the new snapshot's reasons map is
        // about entries.
        reasonCode: null,
        reason: null,
      });
    }
  }
  return rows;
}

/**
 * Persist diff rows. Uses INSERT ... ON CONFLICT DO NOTHING so re-running
 * the diff for the same source snapshot is a no-op (idempotency via the
 * unique index). Caller passes either the read/write Knex or a
 * transaction; the function doesn't open its own transaction so callers
 * keep snapshot writes + diff writes atomic.
 */
export async function persistStateChangeRows(
  db: Knex | Knex.Transaction,
  rows: StateChangeRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await db(ANALYTICS_STATE_CHANGE_TABLE)
    .insert(rows)
    .onConflict([
      "org",
      "subject",
      "cohort",
      "sourceSnapshotId",
      "transition",
    ])
    .ignore();
}

/**
 * Auto-DDL the state-change table. Idempotent — safe to call from
 * `installAnalytics()` on every boot.
 */
export async function ensureStateChangeTable(db: Knex): Promise<void> {
  const exists = await db.schema.hasTable(ANALYTICS_STATE_CHANGE_TABLE);
  if (!exists) {
    await db.schema.createTable(ANALYTICS_STATE_CHANGE_TABLE, (t) => {
      t.string("id", 32).primary();
      t.string("org", 64).notNullable();
      t.string("subject", 64).notNullable();
      t.string("cohort", 128).notNullable();
      t.string("transition", 8).notNullable();
      t.timestamp("occurredAt", { useTz: true }).notNullable();
      t.string("metricKey", 128).notNullable();
      t.string("sourceSnapshotId", 32).notNullable();
      t.string("previousSnapshotId", 32).nullable();
      t.string("reasonCode", 64).nullable();
      t.text("reason").nullable();
      t.timestamp("createdAt", { useTz: true }).notNullable().defaultTo(db.fn.now());
    });
    await db.raw(
      `CREATE UNIQUE INDEX analytics_state_change_idempotent_idx
         ON ${ANALYTICS_STATE_CHANGE_TABLE}
         (org, subject, cohort, "sourceSnapshotId", transition)`,
    );
  } else {
    await assertStructuralColumns(db, ANALYTICS_STATE_CHANGE_TABLE, [
      "id",
      "org",
      "subject",
      "cohort",
      "transition",
      "occurredAt",
      "metricKey",
      "sourceSnapshotId",
    ]);
    await assertUniqueConflictTarget(db, ANALYTICS_STATE_CHANGE_TABLE, [
      "org",
      "subject",
      "cohort",
      "sourceSnapshotId",
      "transition",
    ]);
    await ensureAdditiveColumn(db, ANALYTICS_STATE_CHANGE_TABLE, "previousSnapshotId", (t) =>
      t.string("previousSnapshotId", 32).nullable(),
    );
    await ensureAdditiveColumn(db, ANALYTICS_STATE_CHANGE_TABLE, "reasonCode", (t) =>
      t.string("reasonCode", 64).nullable(),
    );
    await ensureAdditiveColumn(db, ANALYTICS_STATE_CHANGE_TABLE, "reason", (t) =>
      t.text("reason").nullable(),
    );
    await ensureAdditiveColumn(db, ANALYTICS_STATE_CHANGE_TABLE, "createdAt", (t) =>
      t.timestamp("createdAt", { useTz: true }).notNullable().defaultTo(db.fn.now()),
    );
  }
  await db.raw(
    `CREATE INDEX IF NOT EXISTS analytics_state_change_subject_idx
       ON ${ANALYTICS_STATE_CHANGE_TABLE} (org, subject, "occurredAt" DESC)`,
  );
  await db.raw(
    `CREATE INDEX IF NOT EXISTS analytics_state_change_cohort_idx
       ON ${ANALYTICS_STATE_CHANGE_TABLE} (org, cohort, "occurredAt" DESC)`,
  );
}
