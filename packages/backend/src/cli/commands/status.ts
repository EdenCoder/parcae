/**
 * `parcae migrate:status` — one-line summary of the migration state.
 */

import { buildListing, readMetaRows } from "../../adapters/migration-meta";
import { readApplied, type CliRuntime } from "../runtime";
import { withRuntime } from "../with-runtime";
import type { CommandResult } from "../output";

export interface StatusResult {
  readonly total: number;
  readonly applied: number;
  readonly pending: number;
  readonly drift: number;
  readonly orphans: number;
}

export async function run(
  _positional: readonly string[],
  flags: Record<string, string | boolean>,
  runtime?: CliRuntime,
): Promise<CommandResult<StatusResult>> {
  return withRuntime(flags, runtime, async (rt) => {
    const [applied, meta] = await Promise.all([
      readApplied(rt.db, rt.tableName),
      readMetaRows(rt.db),
    ]);
    const listing = buildListing(rt.entries, applied, meta);

    const counts = {
      total: listing.length,
      applied: listing.filter((m) => m.state === "applied").length,
      pending: listing.filter((m) => m.state === "pending").length,
      drift: listing.filter((m) => m.state === "drift").length,
      orphans: listing.filter((m) => m.state === "orphan").length,
    };

    const text =
      `${counts.applied} applied, ${counts.pending} pending, ` +
      `${counts.drift} drift, ${counts.orphans} orphan` +
      ` (${counts.total} total)`;

    return { text, data: counts };
  });
}
