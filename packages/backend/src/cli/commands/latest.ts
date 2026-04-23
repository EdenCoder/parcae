/**
 * `parcae migrate:latest` — apply all pending migrations out-of-band.
 * Same engine as the startup path — shares `runMigrations()`.
 */

import { runMigrations } from "../../adapters/migrations";
import type { CliRuntime } from "../runtime";
import { withRuntime } from "../with-runtime";
import type { CommandResult } from "../output";

export interface LatestResult {
  readonly applied: readonly string[];
  readonly total: number;
}

export async function run(
  _positional: readonly string[],
  flags: Record<string, string | boolean>,
  runtime?: CliRuntime,
): Promise<CommandResult<LatestResult>> {
  return withRuntime(flags, runtime, async (rt) => {
    const result = await runMigrations({
      db: rt.db,
      entries: rt.entries,
      engine: rt.engine,
      allowChecksumDrift: flags["allow-checksum-drift"] === true,
    });

    const text =
      result.applied.length === 0
        ? `Up to date (${result.total} total)`
        : `Applied ${result.applied.length} migration(s):\n` +
          result.applied.map((n) => `  • ${n}`).join("\n");

    return { text, data: result };
  });
}
