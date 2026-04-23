/**
 * `parcae migrate:rollback` — reverse the last batch of applied migrations.
 *
 * Errors loudly if any migration in the last batch lacks a `down` handler —
 * we don't silently skip because that'd leave the app in an inconsistent
 * state (some rolled back, some not).
 */

import { ParcaeMigrationSource } from "../../adapters/migrations";
import {
  readMetaRows,
  verifyChecksums,
} from "../../adapters/migration-meta";
import { bootstrap, type CliRuntime } from "../runtime";
import type { CommandResult } from "../output";

export interface RollbackResult {
  rolledBack: string[];
}

export async function run(
  _positional: readonly string[],
  flags: Record<string, string | boolean>,
  runtime?: CliRuntime,
): Promise<CommandResult<RollbackResult>> {
  const rt =
    runtime ??
    (await bootstrap({
      dir: typeof flags.dir === "string" ? flags.dir : undefined,
      db: typeof flags.db === "string" ? flags.db : undefined,
    }));
  const ownsRuntime = runtime === undefined;
  try {
    // Determine which migrations are in the last batch — that's what a
    // rollback will reverse.
    const hasTable = await rt.db.schema.hasTable(rt.tableName);
    if (!hasTable) {
      return { text: "Nothing to roll back — no migrations applied.", data: { rolledBack: [] } };
    }

    const rows = await rt.db<{ name: string; batch: number }>(rt.tableName)
      .select("name", "batch")
      .orderBy("batch", "desc")
      .orderBy("id", "desc");

    if (rows.length === 0) {
      return { text: "Nothing to roll back — no migrations applied.", data: { rolledBack: [] } };
    }

    const lastBatch = rows[0]!.batch;
    const lastBatchNames = rows.filter((r) => r.batch === lastBatch).map((r) => r.name);

    // Validate every last-batch migration has a down() handler before starting.
    const registered = new Map(rt.entries.map((e) => [e.name, e]));
    const missing: string[] = [];
    for (const name of lastBatchNames) {
      const entry = registered.get(name);
      if (!entry) {
        throw new Error(
          `[parcae] cannot roll back — migration "${name}" is in the last batch ` +
            `but no file was found. It may have been deleted from the repo. ` +
            `Restore the file (with a valid down()) and retry.`,
        );
      }
      if (!entry.down) missing.push(name);
    }
    if (missing.length > 0) {
      throw new Error(
        `[parcae] cannot roll back — the following migrations in the last batch ` +
          `have no down() handler:\n` +
          missing.map((n) => `  - ${n}`).join("\n") +
          `\n\nParcae migrations are forward-only by default. Write a new ` +
          `compensating migration instead, or add a down() to the file(s) above.`,
      );
    }

    // Re-verify checksums before running any down(). An operator who edits a
    // migration's file post-apply and then rolls back would otherwise run
    // the modified down() against the DB with no warning.
    const allowDrift = flags["allow-checksum-drift"] === true;
    const meta = await readMetaRows(rt.db);
    verifyChecksums(rt.entries, meta, allowDrift);

    const source = new ParcaeMigrationSource(rt.entries, rt.engine);
    const result = (await rt.db.migrate.rollback(
      {
        tableName: rt.tableName,
        migrationSource: source,
      },
      false,
    )) as [number, string[]];

    const rolledBack = Array.isArray(result) ? (result[1] ?? []) : [];

    return {
      text:
        rolledBack.length === 0
          ? "Nothing was rolled back."
          : `Rolled back ${rolledBack.length} migration(s):\n` +
            rolledBack.map((n) => `  • ${n}`).join("\n"),
      data: { rolledBack },
    };
  } finally {
    if (ownsRuntime) await rt.close();
  }
}
