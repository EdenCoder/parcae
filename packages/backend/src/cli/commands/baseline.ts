/**
 * `parcae migrate:baseline <name>` — stamp migrations up to <name> as applied
 * without running them. Answers the "our prod DB already has these, don't
 * re-run them" problem for apps adopting the migration system late.
 *
 * Rows are written atomically to BOTH Knex's `parcae_migrations` and the
 * companion `parcae_migration_meta` in a single transaction.
 */

import type { Knex } from "knex";
import {
  MIGRATIONS_TABLE,
} from "../../adapters/migrations";
import { META_TABLE, sha256File } from "../../adapters/migration-meta";
import type { MigrationEntry } from "../../routing/migration";
import { bootstrap, readApplied, type CliRuntime } from "../runtime";
import type { CommandResult } from "../output";

export interface BaselineResult {
  stamped: string[];
  alreadyApplied: string[];
  dryRun: boolean;
}

export async function run(
  positional: readonly string[],
  flags: Record<string, string | boolean>,
  runtime?: CliRuntime,
): Promise<CommandResult<BaselineResult>> {
  const target = positional[0];
  if (!target) {
    throw new Error(
      "Usage: parcae migrate:baseline <name>\n\n" +
        "Stamps all migrations with names lexicographically ≤ <name> as\n" +
        "applied without running them.",
    );
  }

  const dryRun = flags["dry-run"] === true;
  const rt =
    runtime ??
    (await bootstrap({
      dir: typeof flags.dir === "string" ? flags.dir : undefined,
      db: typeof flags.db === "string" ? flags.db : undefined,
    }));
  const ownsRuntime = runtime === undefined;
  try {
    const applied = await readApplied(rt.db, rt.tableName);

    const candidates = rt.entries.filter((e) => e.name.localeCompare(target) <= 0);
    if (candidates.length === 0) {
      throw new Error(
        `[parcae] no migrations match "${target}" or earlier. Available:\n` +
          rt.entries.map((e) => `  - ${e.name}`).join("\n"),
      );
    }
    if (!candidates.some((e) => e.name === target)) {
      throw new Error(
        `[parcae] no migration named "${target}". Closest matches:\n` +
          rt.entries
            .map((e) => e.name)
            .filter((n) => n.includes(target))
            .slice(0, 5)
            .map((n) => `  - ${n}`)
            .join("\n"),
      );
    }

    const toStamp = candidates.filter((e) => !applied.has(e.name));
    const alreadyApplied = candidates
      .filter((e) => applied.has(e.name))
      .map((e) => e.name);

    if (toStamp.length === 0) {
      return {
        text:
          `Nothing to baseline — all ${candidates.length} candidate(s) already applied.`,
        data: {
          stamped: [],
          alreadyApplied,
          dryRun,
        },
      };
    }

    if (dryRun) {
      return {
        text:
          `Would baseline ${toStamp.length} migration(s) (dry run):\n` +
          toStamp.map((e) => `  • ${e.name}`).join("\n"),
        data: {
          stamped: toStamp.map((e) => e.name),
          alreadyApplied,
          dryRun: true,
        },
      };
    }

    await stampAsApplied(rt.db, rt.tableName, toStamp);

    return {
      text:
        `Baselined ${toStamp.length} migration(s):\n` +
        toStamp.map((e) => `  • ${e.name}`).join("\n"),
      data: {
        stamped: toStamp.map((e) => e.name),
        alreadyApplied,
        dryRun: false,
      },
    };
  } finally {
    if (ownsRuntime) await rt.close();
  }
}

/**
 * Insert Knex's `parcae_migrations` rows AND our companion meta rows in a
 * single transaction so an interrupted baseline doesn't leave the two tables
 * out of sync. Knex's schema for its migrations table is `(id, name, batch,
 * migration_time)` — we write `batch = 0` so baselined entries are visually
 * distinct from anything the runner applies (which starts at batch 1).
 */
async function stampAsApplied(
  db: Knex,
  tableName: string,
  entries: readonly MigrationEntry[],
): Promise<void> {
  // Knex creates `parcae_migrations` lazily on first `migrate.latest()`.
  // When baselining on a fresh DB, the table won't exist yet — create it
  // with the exact schema Knex expects so its migrator recognises it later.
  if (!(await db.schema.hasTable(tableName))) {
    await db.schema.createTable(tableName, (t) => {
      t.increments("id").primary();
      t.string("name");
      t.integer("batch");
      t.timestamp("migration_time");
    });
  }

  const appliedAt = new Date();
  await db.transaction(async (trx) => {
    await trx(tableName).insert(
      entries.map((e) => ({
        name: e.name,
        batch: 0,
        migration_time: appliedAt.toISOString(),
      })),
    );
    await trx(META_TABLE)
      .insert(
        entries.map((e) => ({
          name: e.name,
          checksum: sha256File(e.path),
          description: e.description,
          ticket: e.ticket,
          durationMs: 0,
          appliedAt: appliedAt.toISOString(),
        })),
      )
      .onConflict("name")
      .merge();
  });
}

// MIGRATIONS_TABLE import retained for clarity even though `rt.tableName`
// is preferred inside the function.
void MIGRATIONS_TABLE;
