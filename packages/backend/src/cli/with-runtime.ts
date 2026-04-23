/**
 * @parcae/backend — CLI runtime helper
 *
 * Every command needs the same skeleton: use an injected runtime if one was
 * passed (test/embedded use), otherwise bootstrap one from `--dir`/`--db`
 * flags, and close it when done. Centralising the pattern keeps each command
 * focused on its actual work.
 */

import { bootstrap, type BootstrapOptions, type CliRuntime } from "./runtime";

/**
 * Run `body` against a CliRuntime, handling bootstrap + cleanup. When the
 * caller already owns a runtime (e.g. tests injecting a shared connection),
 * it's reused as-is and NOT closed here.
 */
export async function withRuntime<T>(
  flags: Record<string, string | boolean>,
  injected: CliRuntime | undefined,
  body: (rt: CliRuntime) => Promise<T>,
  overrides: Pick<BootstrapOptions, "skipDiscovery" | "entries"> = {},
): Promise<T> {
  const rt =
    injected ??
    (await bootstrap({
      dir: typeof flags.dir === "string" ? flags.dir : undefined,
      db: typeof flags.db === "string" ? flags.db : undefined,
      ...overrides,
    }));
  const ownsRuntime = injected === undefined;
  try {
    return await body(rt);
  } finally {
    if (ownsRuntime) await rt.close();
  }
}
