/**
 * `parcae migrate:status` — one-line summary of the migration state.
 */

import { buildListing, readMetaRows } from "../../adapters/migration-meta";
import { bootstrap, readApplied, type CliRuntime } from "../runtime";
import type { CommandResult } from "../output";

export interface StatusResult {
  total: number;
  applied: number;
  pending: number;
  drift: number;
  orphans: number;
}

export async function run(
  _positional: readonly string[],
  flags: Record<string, string | boolean>,
  runtime?: CliRuntime,
): Promise<CommandResult<StatusResult>> {
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
  } finally {
    if (ownsRuntime) await rt.close();
  }
}
