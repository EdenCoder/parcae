/**
 * @parcae/backend — migration discovery
 *
 * Imports every migration file in a directory and associates the resulting
 * registry entries with their source-file paths. Used by:
 *
 *   - `createApp().start()` — to boot the migration system from a directory
 *   - The CLI — so all commands share the same discovery path
 *
 * The association strategy relies on `migration()` being the registration
 * side effect: we snapshot the registry length before each file's import,
 * then tag any entries added during that import with the file's absolute
 * path. A file that registers no migrations is warned; a file that
 * registers multiple entries is allowed (each gets the same `path`).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "../logger";
import {
  _getInsertionOrdered,
  type MigrationEntry,
} from "../routing/migration";

/**
 * List migration files in a directory — flat (no recursion), lexicographic,
 * only `.ts`/`.js` files, skipping dotfiles / underscore-prefixed / `index.*`.
 */
export function listMigrationFiles(dir: string): string[] {
  const abs = resolve(dir);
  if (!existsSync(abs)) return [];

  const names = readdirSync(abs).filter((name) => {
    if (name.startsWith(".") || name.startsWith("_")) return false;
    if (name === "index.ts" || name === "index.js") return false;
    if (!name.endsWith(".ts") && !name.endsWith(".js")) return false;
    const full = join(abs, name);
    return statSync(full).isFile();
  });

  names.sort((a, b) => a.localeCompare(b));
  return names.map((name) => join(abs, name));
}

/**
 * Import every migration file in `dir`, tagging registered entries with the
 * originating file path. Returns only the entries added during this call
 * (useful when migrations may have been pre-registered programmatically).
 *
 * Safe to call multiple times — files are loaded via ESM import which is
 * cached per URL; re-invoking does not re-register.
 */
export async function discoverMigrations(
  dir: string,
): Promise<MigrationEntry[]> {
  const files = listMigrationFiles(dir);
  const added: MigrationEntry[] = [];

  for (const file of files) {
    const raw = _getInsertionOrdered();
    const beforeLen = raw.length;
    try {
      await import(pathToFileURL(file).href);
    } catch (err) {
      log.warn(
        `[parcae/migration] failed to import ${file}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    const afterLen = raw.length;

    if (afterLen === beforeLen) {
      log.warn(
        `[parcae/migration] ${file} did not register any migration — ` +
          `did you forget to call migration()?`,
      );
      continue;
    }

    // Newly-added entries are at the tail of the underlying registry array
    // (getMigrations() returns a sorted copy — useless for correlating with
    //  import order; the insertion-ordered view is what we need here).
    const newlyAdded = raw.slice(beforeLen, afterLen);
    for (const entry of newlyAdded) {
      entry.path = file;
      added.push(entry);
    }
  }

  return added;
}
