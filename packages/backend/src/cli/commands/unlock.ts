/**
 * `parcae migrate:unlock` — forcibly release the migration lock.
 *
 * Knex acquires a lock via `parcae_migrations_lock` during `migrate.latest()`.
 * If a migrating process crashes mid-run, the row stays locked and subsequent
 * runs will hang waiting. This command wipes the lock so migrations can
 * proceed again.
 *
 * Only run this when you've confirmed no other migration process is active.
 */

import { bootstrap, type CliRuntime } from "../runtime";
import type { CommandResult } from "../output";

export interface UnlockResult {
  tableName: string;
}

export async function run(
  _positional: readonly string[],
  flags: Record<string, string | boolean>,
  runtime?: CliRuntime,
): Promise<CommandResult<UnlockResult>> {
  const rt =
    runtime ??
    (await bootstrap({
      db: typeof flags.db === "string" ? flags.db : undefined,
      skipDiscovery: true,
    }));
  const ownsRuntime = runtime === undefined;
  try {
    await rt.db.migrate.forceFreeMigrationsLock({ tableName: rt.tableName });
    return {
      text: `Released lock on ${rt.tableName}_lock`,
      data: { tableName: rt.tableName },
    };
  } finally {
    if (ownsRuntime) await rt.close();
  }
}
