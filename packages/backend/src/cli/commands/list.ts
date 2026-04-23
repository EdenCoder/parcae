/**
 * `parcae migrate:list` — show every migration with state + metadata.
 */

import {
  buildListing,
  readMetaRows,
  type MigrationListing,
} from "../../adapters/migration-meta";
import { bootstrap, readApplied, type CliRuntime } from "../runtime";
import { renderTable, type CommandResult } from "../output";

export interface ListResult {
  migrations: MigrationListing[];
}

export async function run(
  _positional: readonly string[],
  flags: Record<string, string | boolean>,
  runtime?: CliRuntime,
): Promise<CommandResult<ListResult>> {
  const rt =
    runtime ??
    (await bootstrap({
      dir: typeof flags.dir === "string" ? flags.dir : undefined,
      db: typeof flags.db === "string" ? flags.db : undefined,
    }));
  const ownsRuntime = runtime === undefined;
  try {
    const [applied, meta] = await Promise.all([
      readApplied(rt.db, rt.tableName),
      readMetaRows(rt.db),
    ]);
    const listing = buildListing(rt.entries, applied, meta);

    const text =
      listing.length === 0
        ? "(no migrations)"
        : renderTable(
            ["name", "state", "ticket", "duration", "applied", "description"],
            listing.map((m) => [
              m.name,
              m.state,
              m.ticket,
              m.durationMs != null ? `${m.durationMs}ms` : null,
              m.appliedAt,
              m.description,
            ]),
          );

    return { text, data: { migrations: listing } };
  } finally {
    if (ownsRuntime) await rt.close();
  }
}
