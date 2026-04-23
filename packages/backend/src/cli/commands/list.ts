/**
 * `parcae migrate:list` — show every migration with state + metadata.
 */

import {
  buildListing,
  effectLabel,
  readMetaRows,
  type MigrationListing,
} from "../../adapters/migration-meta";
import { readApplied, type CliRuntime } from "../runtime";
import { withRuntime } from "../with-runtime";
import { renderTable, type CommandResult } from "../output";

export interface ListResult {
  readonly migrations: readonly MigrationListing[];
}

export async function run(
  _positional: readonly string[],
  flags: Record<string, string | boolean>,
  runtime?: CliRuntime,
): Promise<CommandResult<ListResult>> {
  return withRuntime(flags, runtime, async (rt) => {
    const [applied, meta] = await Promise.all([
      readApplied(rt.db, rt.tableName),
      readMetaRows(rt.db),
    ]);
    const listing = buildListing(rt.entries, applied, meta);

    const text =
      listing.length === 0
        ? "(no migrations)"
        : renderTable(
            ["name", "state", "effect", "duration", "ticket", "applied", "description"],
            listing.map((m) => [
              m.name,
              m.state,
              effectLabel(m.effect) || null,
              m.durationMs != null ? `${m.durationMs}ms` : null,
              m.ticket,
              m.appliedAt,
              m.description,
            ]),
          );

    return { text, data: { migrations: listing } };
  });
}
