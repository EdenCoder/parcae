/**
 * @parcae/backend — CLI argv parser
 *
 * Tiny, dependency-free parser for the Parcae CLI surface. We keep it
 * hand-rolled because our command set is small, our flag surface is narrow,
 * and pulling in `commander` / `cac` / `yargs` just to route a dozen commands
 * violates the zero-new-runtime-deps principle.
 *
 * Grammar:
 *   parcae <command> [positional...] [--flag value] [--flag=value] [--bool]
 *
 * Supported flag forms:
 *   --flag value        → string
 *   --flag=value        → string
 *   --bool              → true
 *   --no-bool           → false (only used in contexts that accept it)
 *   -h / --help         → flags.help = true
 *
 * The parser is intentionally permissive — unknown flags pass through on
 * `flags` so individual commands can declare what they accept without the
 * parser needing a global schema.
 */

export interface ParsedArgs {
  /** Primary command, e.g. "migrate:latest". `null` when no command given. */
  command: string | null;
  /** Positional arguments after the command. */
  positional: string[];
  /** Flag map. Values are strings unless the flag was a bare boolean. */
  flags: Record<string, string | boolean>;
}

export function parseArgv(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "--") {
      // Everything after `--` is positional, verbatim
      for (let j = i + 1; j < argv.length; j++) positional.push(argv[j]!);
      break;
    }

    if (token === "-h" || token === "--help") {
      flags.help = true;
      continue;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        const key = body.slice(0, eq);
        flags[key] = body.slice(eq + 1);
      } else if (body.startsWith("no-")) {
        flags[body.slice(3)] = false;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
      continue;
    }

    if (command === null) {
      command = token;
    } else {
      positional.push(token);
    }
  }

  return { command, positional, flags };
}
