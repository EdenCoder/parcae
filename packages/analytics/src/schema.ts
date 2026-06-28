/**
 * @parcae/analytics — Auto-DDL + default Knex emitter
 *
 * Two tables, additive-only DDL. Both are owned by this package, not
 * the consuming app, so consumers never need to write a migration to
 * use the framework. `ensureAnalyticsTables()` is called from
 * `installAnalytics()`.
 */

import type { Knex } from "knex";
import type { AnalyticsEvent, EventEmitter } from "./event.js";
import { setEventEmitter } from "./event.js";
import { generateId } from "./id.js";
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
    await db.raw(
      `CREATE INDEX IF NOT EXISTS analytics_event_org_key_occurred_idx
         ON ${ANALYTICS_EVENT_TABLE} (org, key, "occurredAt" DESC)`,
    );
    await db.raw(
      `CREATE INDEX IF NOT EXISTS analytics_event_org_subject_occurred_idx
         ON ${ANALYTICS_EVENT_TABLE} (org, subject, "occurredAt" DESC)`,
    );
    return;
  }
  await ensureColumn(db, ANALYTICS_EVENT_TABLE, "source", (t) =>
    t.string("source", 16).notNullable().defaultTo("system"),
  );
  await ensureColumn(db, ANALYTICS_EVENT_TABLE, "dimensions", (t) =>
    t.jsonb("dimensions").notNullable().defaultTo("{}"),
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
      `CREATE UNIQUE INDEX IF NOT EXISTS analytics_snapshot_unique_idx
         ON ${ANALYTICS_SNAPSHOT_TABLE}
         (org, "metricKey", grain, "periodStart", dimensions)`,
    );
    await db.raw(
      `CREATE INDEX IF NOT EXISTS analytics_snapshot_lookup_idx
         ON ${ANALYTICS_SNAPSHOT_TABLE} (org, "metricKey", grain, "periodStart" DESC)`,
    );
    return;
  }
}

async function ensureColumn(
  db: Knex,
  table: string,
  column: string,
  add: (t: Knex.AlterTableBuilder) => void,
): Promise<void> {
  const has = await db.schema.hasColumn(table, column);
  if (!has) {
    await db.schema.alterTable(table, add);
  }
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
