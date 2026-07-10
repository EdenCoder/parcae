/**
 * @parcae/analytics — Auto-DDL + default Knex emitter
 *
 * Two package-owned tables. Fresh installs get the complete schema;
 * existing installs only receive safe non-key additions. Missing
 * identity or conflict columns fail loudly for a versioned migration.
 * `ensureAnalyticsTables()` is called from `installAnalytics()`.
 */

import type { Knex } from "knex";
import type { EventEmitter } from "./event.js";
import { setEventEmitter } from "./event.js";
import { generateId } from "./id.js";
import {
  assertUniqueConflictTarget,
  assertStructuralColumns,
  ensureAdditiveColumn,
} from "./schema-upgrade.js";
import { ensureStateChangeTable } from "./state-change.js";

export const ANALYTICS_EVENT_TABLE = "analytics_event";
export const ANALYTICS_SNAPSHOT_TABLE = "analytics_snapshot";

export async function ensureAnalyticsTables(db: Knex): Promise<void> {
  await ensureEventTable(db);
  await ensureSnapshotTable(db);
  await ensureStateChangeTable(db);
}

async function ensureEventTable(db: Knex): Promise<void> {
  const exists = await db.schema.hasTable(ANALYTICS_EVENT_TABLE);
  if (!exists) {
    await db.schema.createTable(ANALYTICS_EVENT_TABLE, (t) => {
      t.string("id", 32).primary();
      t.string("org", 64).notNullable();
      t.string("subject", 64).notNullable();
      t.string("key", 128).notNullable();
      t.timestamp("occurredAt", { useTz: true }).notNullable();
      t.string("source", 16).notNullable().defaultTo("system");
      t.jsonb("dimensions").notNullable().defaultTo("{}");
      t.timestamp("createdAt", { useTz: true }).notNullable().defaultTo(db.fn.now());
    });
  } else {
    await assertStructuralColumns(db, ANALYTICS_EVENT_TABLE, [
      "id",
      "org",
      "subject",
      "key",
      "occurredAt",
    ]);
    await ensureAdditiveColumn(db, ANALYTICS_EVENT_TABLE, "source", (t) =>
      t.string("source", 16).notNullable().defaultTo("system"),
    );
    await ensureAdditiveColumn(db, ANALYTICS_EVENT_TABLE, "dimensions", (t) =>
      t.jsonb("dimensions").notNullable().defaultTo("{}"),
    );
    await ensureAdditiveColumn(db, ANALYTICS_EVENT_TABLE, "createdAt", (t) =>
      t.timestamp("createdAt", { useTz: true }).notNullable().defaultTo(db.fn.now()),
    );
  }
  await db.raw(
    `CREATE INDEX IF NOT EXISTS analytics_event_org_key_occurred_idx
       ON ${ANALYTICS_EVENT_TABLE} (org, key, "occurredAt" DESC)`,
  );
  await db.raw(
    `CREATE INDEX IF NOT EXISTS analytics_event_org_subject_occurred_idx
       ON ${ANALYTICS_EVENT_TABLE} (org, subject, "occurredAt" DESC)`,
  );
}

async function ensureSnapshotTable(db: Knex): Promise<void> {
  const exists = await db.schema.hasTable(ANALYTICS_SNAPSHOT_TABLE);
  if (!exists) {
    await db.schema.createTable(ANALYTICS_SNAPSHOT_TABLE, (t) => {
      t.string("id", 32).primary();
      t.string("org", 64).notNullable();
      t.string("metricKey", 128).notNullable();
      t.string("grain", 8).notNullable();
      t.timestamp("periodStart", { useTz: true }).notNullable();
      t.timestamp("periodEnd", { useTz: true }).notNullable();
      t.decimal("value", 18, 4).notNullable();
      t.jsonb("dimensions").notNullable().defaultTo("{}");
      t.jsonb("metadata").notNullable().defaultTo("{}");
      t.integer("metricVersion").notNullable().defaultTo(1);
      t.timestamp("computedAt", { useTz: true }).notNullable().defaultTo(db.fn.now());
    });
    // JSONB sorts by bytes, not semantically. Consumers MUST upsert
    // through `canonicalDimensions()` so `{a:1,b:2}` and `{b:2,a:1}`
    // hash to the same row instead of two.
    await db.raw(
      `CREATE UNIQUE INDEX analytics_snapshot_unique_idx
         ON ${ANALYTICS_SNAPSHOT_TABLE}
         (org, "metricKey", grain, "periodStart", dimensions)`,
    );
  } else {
    await assertStructuralColumns(db, ANALYTICS_SNAPSHOT_TABLE, [
      "id",
      "org",
      "metricKey",
      "grain",
      "periodStart",
      "periodEnd",
      "value",
      "dimensions",
    ]);
    await assertUniqueConflictTarget(db, ANALYTICS_SNAPSHOT_TABLE, [
      "org",
      "metricKey",
      "grain",
      "periodStart",
      "dimensions",
    ]);
    await ensureAdditiveColumn(db, ANALYTICS_SNAPSHOT_TABLE, "metadata", (t) =>
      t.jsonb("metadata").notNullable().defaultTo("{}"),
    );
    await ensureAdditiveColumn(db, ANALYTICS_SNAPSHOT_TABLE, "metricVersion", (t) =>
      t.integer("metricVersion").notNullable().defaultTo(1),
    );
    await ensureAdditiveColumn(db, ANALYTICS_SNAPSHOT_TABLE, "computedAt", (t) =>
      t.timestamp("computedAt", { useTz: true }).notNullable().defaultTo(db.fn.now()),
    );
  }
  await db.raw(
    `CREATE INDEX IF NOT EXISTS analytics_snapshot_lookup_idx
       ON ${ANALYTICS_SNAPSHOT_TABLE} (org, "metricKey", grain, "periodStart" DESC)`,
  );
}

/**
 * Stable canonical JSON for dimension comparison + upserts. Sorts keys
 * recursively so `{a:1,b:2}` and `{b:2,a:1}` hash identically.
 */
export function canonicalDimensions(d: Record<string, unknown>): string {
  return JSON.stringify(sort(d));
}

function sort(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sort);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = sort(obj[k]);
  return out;
}

/**
 * Default emitter — direct INSERT against the write Knex. Hooks register
 * with `async: true`, so this runs fire-and-forget off the request
 * path. Consumers wanting BullMQ-backed batching can swap in a custom
 * emitter via `setEventEmitter()`.
 */
export function createKnexEmitter(db: Knex): EventEmitter {
  return {
    async emit(event) {
      const id = generateId();
      const row = {
        id,
        org: event.org,
        subject: event.subject,
        key: event.key,
        occurredAt: event.occurredAt,
        source: event.source,
        dimensions: event.dimensions,
      };
      await db(ANALYTICS_EVENT_TABLE).insert(row);
    },
  };
}

/**
 * Wire up: ensure tables exist, install the default Knex emitter.
 * Idempotent — safe to call multiple times.
 */
export async function installAnalytics(db: Knex): Promise<void> {
  await ensureAnalyticsTables(db);
  setEventEmitter(createKnexEmitter(db));
}
