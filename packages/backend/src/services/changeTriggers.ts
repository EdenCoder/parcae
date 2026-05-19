/**
 * Trigger DDL for the LISTEN/NOTIFY change capture path.
 *
 * The `parcae_change_notify()` trigger function emits a JSON payload
 * on the `parcae_change` channel for every INSERT/UPDATE/DELETE that
 * fires the per-table trigger. The payload includes:
 *   - `table` — name of the table being written
 *   - `op` — `"insert" | "update" | "delete"`
 *   - `id` — primary key (always present, NEW.id on insert/update,
 *            OLD.id on delete)
 *   - `requestId` — the value of `current_setting('parcae.request_id',
 *                   true)`, or empty string when no session variable
 *                   is set
 *
 * Triggers are installed during `ensureAllTables()` alongside the
 * existing tsvector/embedding columns. Both function and trigger are
 * idempotent — re-running `CREATE OR REPLACE FUNCTION` and the
 * drop-then-create trigger pattern is safe across boots.
 *
 * Why a STATEMENT-LEVEL trigger isn't enough: it fires once per
 * statement, not once per row. For a multi-row `UPDATE` we want one
 * change notification per affected id so subscribers can prune by
 * id without re-querying for every row. Row-level triggers have a
 * higher per-write cost, but the workload we care about (one-write-
 * per-tick UI gestures, plus job-driven batches) is dominated by
 * single-row writes. The patch path's per-block updates are still
 * one notification each, which matches today's hook-path semantics.
 */

import { log } from "../logger";

export const TRIGGER_FUNCTION_NAME = "parcae_change_notify";
export const TRIGGER_PREFIX = "parcae_change_";

/**
 * SQL for the trigger function. Reads `parcae.request_id` if the
 * write was wrapped via `withTransaction(setRequestIdGuc: true)`
 * (or its equivalent inline `SET LOCAL parcae.request_id`) — that
 * way ChangeBus can dedup the LISTEN echo of a hook-path write.
 *
 * `current_setting(name, true)` returns NULL when the GUC isn't set,
 * which we coerce to an empty string in the payload so the JSON
 * shape stays stable.
 */
export function triggerFunctionSql(): string {
  return `
CREATE OR REPLACE FUNCTION ${TRIGGER_FUNCTION_NAME}() RETURNS trigger AS $$
DECLARE
  payload json;
  rid text;
  row_id text;
BEGIN
  rid := COALESCE(current_setting('parcae.request_id', true), '');
  IF TG_OP = 'DELETE' THEN
    row_id := OLD.id;
  ELSE
    row_id := NEW.id;
  END IF;
  payload := json_build_object(
    'table', TG_TABLE_NAME,
    'op', lower(TG_OP),
    'id', row_id,
    'requestId', rid
  );
  PERFORM pg_notify('parcae_change', payload::text);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;
  `.trim();
}

// Hyphens are legal in quoted table names but not in unquoted
// trigger identifiers, so kebab-case tables (`chat-messages`)
// would emit `parcae_change_chat-messages` and Postgres would
// reject the DROP/CREATE with `syntax error at or near "-"`.
// Sanitize once at the boundary so callers can use bare names.
export function triggerName(table: string): string {
  return `${TRIGGER_PREFIX}${table.replaceAll("-", "_")}`;
}

/**
 * Per-table trigger SQL. AFTER INSERT/UPDATE/DELETE fires after the
 * write is committed inside the trx — the pg_notify is then queued
 * onto the COMMIT boundary by Postgres itself, so listeners only see
 * the event if the trx actually committed (rolled-back trxs leak
 * nothing). Row-level so multi-row UPDATEs surface every affected id.
 */
export function createTriggerSql(table: string): string {
  const name = triggerName(table);
  return [
    `DROP TRIGGER IF EXISTS ${name} ON "${table}"`,
    `CREATE TRIGGER ${name}
      AFTER INSERT OR UPDATE OR DELETE ON "${table}"
      FOR EACH ROW EXECUTE FUNCTION ${TRIGGER_FUNCTION_NAME}()`,
  ].join(";\n");
}

/**
 * Install the trigger function + per-table trigger via the given
 * knex instance. Idempotent — safe to call multiple times.
 *
 * Skips silently on SQLite (the caller should also gate on engine).
 * The Postgres-only DDL would otherwise throw `near "OR": syntax
 * error` and abort `ensureAllTables`.
 */
export async function ensureChangeTriggers(opts: {
  knex: any;
  engine: "postgres" | "alloydb" | "sqlite";
  tables: string[];
}): Promise<void> {
  if (opts.engine === "sqlite") return;
  if (opts.tables.length === 0) return;

  // Sanitization is silent (kebab → snake), so two tables that
  // differ only in `-` vs `_` would collide on the trigger name
  // and the second install would clobber the first. Detect at
  // boot rather than silently overwriting.
  const byTriggerName = new Map<string, string>();
  for (const table of opts.tables) {
    const name = triggerName(table);
    const prior = byTriggerName.get(name);
    if (prior && prior !== table) {
      throw new Error(
        `changeTriggers: trigger name collision: tables ${prior} and ${table} both sanitize to ${name}`,
      );
    }
    byTriggerName.set(name, table);
  }

  try {
    await opts.knex.raw(triggerFunctionSql());
  } catch (err) {
    log.warn(
      `changeTriggers: failed to ensure trigger function (continuing without LISTEN/NOTIFY): ${
        (err as Error).message
      }`,
    );
    return;
  }

  for (const table of opts.tables) {
    try {
      // We have to split on `;` because knex `raw()` only runs the
      // first statement. The DROP IF EXISTS + CREATE is two statements.
      const statements = createTriggerSql(table)
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of statements) {
        await opts.knex.raw(stmt);
      }
    } catch (err) {
      log.warn(
        `changeTriggers: failed to install trigger for table=${table}: ${
          (err as Error).message
        }`,
      );
    }
  }
  log.info(
    `changeTriggers: installed for ${opts.tables.length} table(s)`,
  );
}
