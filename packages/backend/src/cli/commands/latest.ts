/**
 * `parcae migrate:latest` — apply all pending migrations out-of-band.
 * Same engine as the startup path — shares `runMigrations()`.
 */

import { runMigrations } from "../../adapters/migrations";
import { bootstrap, type CliRuntime } from "../runtime";
import type { CommandResult } from "../output";

export interface LatestResult {
  applied: string[];
  total: number;
}

export async function run(
  _positional: readonly string[],
  flags: Record<string, string | boolean>,
  runtime?: CliRuntime,
): Promise<CommandResult<LatestResult>> {
  const rt =
    runtime ??
    (await bootstrap({
      dir: typeof flags.dir === "string" ? flags.dir : undefined,
      db: typeof flags.db === "string" ? flags.db : undefined,
    }));
  const ownsRuntime = runtime === undefined;
  try {
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
  } finally {
    if (ownsRuntime) await rt.close();
  }
}
