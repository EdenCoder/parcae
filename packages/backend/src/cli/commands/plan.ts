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
import type { Engine } from "../../adapters/engine";
import {
  classifyStatement,
} from "../../adapters/migration-meta";
import type {
  MigrationContext,
  MigrationEntry,
} from "../../routing/migration";
import { readApplied, type CliRuntime } from "../runtime";
import { withRuntime } from "../with-runtime";
import { renderList, type CommandResult } from "../output";

export interface PlanResult {
  readonly migration: string | null;
  readonly statements: readonly string[];
  /** True when the next pending migration is non-transactional (skipped). */
  readonly skipped: boolean;
  readonly skipReason?: string;
}

/**
 * Unique Symbol we stamp on the error thrown to force the transaction to roll
 * back. `err instanceof X` is fragile across Knex/pg's error-wrapping layers;
 * a Symbol property survives wrapping because it's a non-enumerable own
 * property, not bound to a prototype chain.
 */
const ROLLBACK_TAG: unique symbol = Symbol("parcae-plan-rollback");
function isRollbackSentinel(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { [ROLLBACK_TAG]?: true })[ROLLBACK_TAG] === true
  );
}

export async function run(
  _positional: readonly string[],
  flags: Record<string, string | boolean>,
  runtime?: CliRuntime,
): Promise<CommandResult<PlanResult>> {
  return withRuntime(flags, runtime, async (rt) => {
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
  });
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
  engine: Engine,
): Promise<string[]> {
  const statements: string[] = [];
  const listener = (query: { sql?: string }) => {
    if (query?.sql) statements.push(query.sql);
  };

  try {
    await db.transaction(async (trx) => {
      trx.on("query", listener);
      const ctx: MigrationContext = {
        db: trx,
        engine,
        log,
        ensureModel: async () => {
          throw new Error(
            "[parcae] ensureModel() is unavailable under `migrate:plan` — " +
              "the CLI has no adapter. Plan this migration against a staging " +
              "DB with the server booted, or inline the DDL with `db.raw(...)`.",
          );
        },
      };
      await entry.up(ctx);
      const sentinel: { [ROLLBACK_TAG]: true } & Error = Object.assign(
        new Error("parcae: planned rollback"),
        { [ROLLBACK_TAG]: true as const },
      );
      throw sentinel;
    });
  } catch (err) {
    if (!isRollbackSentinel(err)) {
      throw err;
    }
  }

  // Filter out the transaction's own BEGIN/COMMIT/ROLLBACK boilerplate — the
  // user only cares about the migration's statements. Reuse the same
  // classifier the runner uses to avoid maintaining a parallel noise list.
  return statements.filter((s) => classifyStatement(s) !== "noise");
}
