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
 *   - `changedFields` — top-level columns whose values changed on UPDATE
 *
 * Triggers are installed during schema setup and verified before a server
 * starts listening. `CREATE OR REPLACE` keeps schema installation idempotent
 * without opening a drop/recreate gap where committed writes go unseen.
 *
 * Why a STATEMENT-LEVEL trigger isn't enough: it fires once per
 * statement, not once per row. For a multi-row `UPDATE` we want one
 * change notification per affected id so subscribers can prune by
 * id without re-querying for every row. Row-level triggers have a
 * higher per-write cost, but the workload we care about (one-write-
 * per-tick UI gestures, plus job-driven batches) is dominated by
 * single-row writes.
 */

export const TRIGGER_FUNCTION_NAME = "parcae_change_notify";
export const TRIGGER_PREFIX = "parcae_change_";
export const PARCAE_CHANGE_CHANNEL = "parcae_change";
export const TRIGGER_FUNCTION_VERSION = "parcae_change_notify:v2";

/**
 * SQL for the trigger function. Postgres queues NOTIFY delivery until commit,
 * so rolled-back writes never reach listeners and no application-side
 * transaction tagging or deduplication is needed.
 */
export function triggerFunctionSql(): string {
  return `
CREATE OR REPLACE FUNCTION ${TRIGGER_FUNCTION_NAME}() RETURNS trigger AS $$
DECLARE
  payload json;
  row_id text;
  changed_fields json;
BEGIN
  -- ${TRIGGER_FUNCTION_VERSION}
  IF TG_OP = 'DELETE' THEN
    row_id := OLD.id;
  ELSE
    row_id := NEW.id;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT COALESCE(json_agg(field), '[]'::json)
      INTO changed_fields
      FROM (
        SELECT next.key AS field
          FROM jsonb_each(to_jsonb(NEW)) AS next
         WHERE next.value IS DISTINCT FROM (to_jsonb(OLD) -> next.key)
      ) AS changed;
  ELSE
    changed_fields := '[]'::json;
  END IF;
  payload := json_build_object(
    'table', TG_TABLE_NAME,
    'op', lower(TG_OP),
    'id', row_id,
    'changedFields', changed_fields
  );
  PERFORM pg_notify('${PARCAE_CHANGE_CHANNEL}', payload::text);
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
  return `${TRIGGER_PREFIX}${table.replaceAll("-", "_")}`.toLowerCase();
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
  return `CREATE OR REPLACE TRIGGER ${name}
    AFTER INSERT OR UPDATE OR DELETE ON "${table}"
    FOR EACH ROW EXECUTE FUNCTION ${TRIGGER_FUNCTION_NAME}()`;
}

/**
 * Install the trigger function + per-table trigger via the given
 * knex instance. Idempotent — safe to call multiple times.
 *
 * Trigger installation is part of the realtime contract. Failures propagate
 * so an app cannot start while silently missing its only change source.
 */
export async function ensureChangeTriggers(opts: {
  knex: any;
  tables: string[];
}): Promise<void> {
  if (opts.tables.length === 0) return;

  await opts.knex.raw(triggerFunctionSql());

  for (const table of opts.tables) {
    await opts.knex.raw(createTriggerSql(table));
  }
}

/** Fail startup when migrations have not installed the required triggers. */
export async function verifyChangeTriggers(opts: {
  knex: any;
  tables: string[];
}): Promise<void> {
  if (opts.tables.length === 0) return;
  const response = await opts.knex.raw(
    `SELECT c.relname AS "tableName",
            n.nspname AS "tableSchema",
            t.tgname AS "triggerName",
            t.tgenabled AS "triggerEnabled",
            t.tgtype AS "triggerType",
            t.tgqual AS "triggerCondition",
            p.proname AS "functionName",
            pn.nspname AS "functionSchema",
            pg_get_functiondef(p.oid) AS "functionDefinition"
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = t.tgfoid
       JOIN pg_namespace pn ON pn.oid = p.pronamespace
      WHERE n.nspname = current_schema()
        AND NOT t.tgisinternal
        AND c.relname = ANY(?)`,
    [opts.tables],
  );
  const installed = new Set(
    (response?.rows ?? response ?? [])
      .filter(
        (row: Record<string, unknown>) =>
          row.functionName === TRIGGER_FUNCTION_NAME &&
          row.functionSchema === row.tableSchema &&
          (row.triggerEnabled === "O" || row.triggerEnabled === "A") &&
          Number(row.triggerType) === 29 &&
          row.triggerCondition === null &&
          typeof row.functionDefinition === "string" &&
          row.functionDefinition.includes(TRIGGER_FUNCTION_VERSION) &&
          row.functionDefinition.includes(
            `pg_notify('${PARCAE_CHANGE_CHANNEL}'`,
          ),
      )
      .map(
        (row: Record<string, string>) =>
          `${row.tableName}\0${row.triggerName}`,
      ),
  );
  const missing = opts.tables.filter(
    (table) => !installed.has(`${table}\0${triggerName(table)}`),
  );
  if (missing.length > 0) {
    throw new Error(
      `changeTriggers: missing realtime triggers for ${missing.join(", ")}; run schema migrations with ENSURE_SCHEMA=true`,
    );
  }
}
