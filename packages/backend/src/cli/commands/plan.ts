/**
 * `parcae migrate:plan` — dry-run the next pending migration.
 *
 * Opens a transaction, attaches Knex's `query` event listener, runs the
 * migration's `up()`, then throws a sentinel error to force rollback. The
 * captured SQL becomes the output — nothing is committed.
 *
 * Refuses to plan `{ transaction: false }` migrations because the whole
 * mechanism relies on a rolled-back transaction. Users running such
 * migrations should use a staging DB instead.
 */

import type { Knex } from "knex";
import { log } from "../../logger";
import type {
  MigrationContext,
  MigrationEntry,
} from "../../routing/migration";
import { bootstrap, readApplied, type CliRuntime } from "../runtime";
import { renderList, type CommandResult } from "../output";

export interface PlanResult {
  migration: string | null;
  statements: string[];
  /** True when the next pending migration is non-transactional (skipped). */
  skipped: boolean;
  skipReason?: string;
}

class RollbackMarker extends Error {}

export async function run(
  _positional: readonly string[],
  flags: Record<string, string | boolean>,
  runtime?: CliRuntime,
): Promise<CommandResult<PlanResult>> {
  const rt =
    runtime ??
    (await bootstrap({
      dir: typeof flags.dir === "string" ? flags.dir : undefined,
      db: typeof flags.db === "string" ? flags.db : undefined,
    }));
  const ownsRuntime = runtime === undefined;
  try {
    const applied = await readApplied(rt.db, rt.tableName);
    const next = rt.entries.find((e) => !applied.has(e.name));

    if (!next) {
      return {
        text: "Up to date — nothing to plan.",
        data: { migration: null, statements: [], skipped: false },
      };
    }

    if (!next.transaction) {
      return {
        text:
          `Cannot plan "${next.name}" — declared with { transaction: false }.\n` +
          `The dry-run mechanism relies on transactional rollback. Run it on a\n` +
          `staging DB instead, or wrap the inner statements in your own tx guard.`,
        data: {
          migration: next.name,
          statements: [],
          skipped: true,
          skipReason: "transaction: false",
        },
        exitCode: 2,
      };
    }

    const statements = await captureSql(rt.db, next, rt.engine);
    const text =
      `[${next.name}] ${statements.length} statement(s) (rolled back):\n\n` +
      renderList(statements, { numbered: true });
    return {
      text,
      data: { migration: next.name, statements, skipped: false },
    };
  } finally {
    if (ownsRuntime) await rt.close();
  }
}

/**
 * Run the migration's up() inside a transaction that we force to roll back.
 * Knex's `query` event fires for every SQL statement executed through the
 * connection — including the migration's DDL/DML — so we can assemble the
 * full plan without parsing anything.
 */
async function captureSql(
  db: Knex,
  entry: MigrationEntry,
  engine: "sqlite" | "postgres" | "alloydb",
): Promise<string[]> {
  const statements: string[] = [];
  const listener = (query: { sql?: string }) => {
    if (query?.sql) statements.push(query.sql);
  };

  try {
    await db.transaction(async (trx) => {
      trx.on("query", listener);
      const ctx: MigrationContext = { db: trx, engine, log };
      await entry.up(ctx);
      throw new RollbackMarker();
    });
  } catch (err) {
    if (!(err instanceof RollbackMarker)) {
      throw err;
    }
  }

  // Filter out the transaction's own BEGIN/COMMIT/ROLLBACK boilerplate — the
  // user only cares about the migration's statements.
  return statements.filter((s) => {
    const trimmed = s.trim().toUpperCase();
    return !(
      trimmed === "BEGIN" ||
      trimmed === "COMMIT" ||
      trimmed === "ROLLBACK" ||
      trimmed.startsWith("BEGIN;") ||
      trimmed.startsWith("ROLLBACK;")
    );
  });
}
