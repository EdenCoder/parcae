/**
 * @parcae/backend — CLI dispatcher
 *
 * Routes a parsed command to its handler, renders the result, and handles
 * exit codes. Handlers throw on user errors; the dispatcher catches and
 * formats those to stderr, never leaking stack traces unless PARCAE_DEBUG
 * is set.
 */

import { emit, type CommandResult } from "./output";
import { run as runMake } from "./commands/make";
import { run as runList } from "./commands/list";
import { run as runStatus } from "./commands/status";
import { run as runLatest } from "./commands/latest";
import { run as runBaseline } from "./commands/baseline";
import { run as runUnlock } from "./commands/unlock";
import { run as runRollback } from "./commands/rollback";
import { run as runPlan } from "./commands/plan";
import type { ParsedArgs } from "./argv";

type Handler = (
  positional: readonly string[],
  flags: Record<string, string | boolean>,
) => Promise<CommandResult<unknown>>;

const commands: Record<string, Handler> = {
  "migrate:make": runMake,
  "migrate:list": runList,
  "migrate:status": runStatus,
  "migrate:latest": runLatest,
  "migrate:baseline": runBaseline,
  "migrate:unlock": runUnlock,
  "migrate:rollback": runRollback,
  "migrate:plan": runPlan,
};

const USAGE = `parcae — Parcae framework CLI

Usage:
  parcae <command> [arguments] [flags]

Commands:
  migrate:make <name>         Scaffold a new migration file
  migrate:list                Show every migration and its state
  migrate:status              One-line summary of migration state
  migrate:latest              Apply all pending migrations
  migrate:baseline <name>     Mark migrations ≤ <name> as applied without running
  migrate:unlock              Release a stuck migration lock
  migrate:rollback            Reverse the last applied batch (requires down())
  migrate:plan                Dry-run the next pending migration and print its SQL

Global flags:
  --dir <path>                Migrations directory (default: ./migrations)
  --db <url>                  Override DATABASE_URL
  --json                      Emit structured JSON output
  --allow-checksum-drift      Bypass checksum verification (emergency only)
  --help, -h                  Show help
`;

/**
 * Dispatch a parsed-args object to the appropriate command handler and emit
 * its result. Never throws — errors are formatted to stderr and the process
 * exits non-zero.
 */
export async function dispatch(parsed: ParsedArgs): Promise<void> {
  const { command, positional, flags } = parsed;
  const json = flags.json === true;

  if (!command || flags.help === true) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const handler = commands[command];
  if (!handler) {
    const suggestions = Object.keys(commands)
      .filter((k) => k.includes(command))
      .slice(0, 3);
    const hint =
      suggestions.length > 0
        ? `Did you mean: ${suggestions.join(", ")}?\n\n`
        : "";
    process.stderr.write(
      `Unknown command: ${command}\n${hint}Run \`parcae --help\` for usage.\n`,
    );
    process.exit(2);
  }

  try {
    const result = await handler(positional, flags);
    emit(result, { json });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      process.stderr.write(
        JSON.stringify({ ok: false, error: message }, null, 2) + "\n",
      );
    } else {
      process.stderr.write(message + "\n");
    }
    if (process.env.PARCAE_DEBUG && err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
  }
}
