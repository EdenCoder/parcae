/**
 * @parcae/backend — migration metadata
 *
 * Companion table to Knex's `parcae_migrations`. Stores data Knex doesn't
 * track — checksum, description, ticket, duration, applied-at. We keep these
 * in a parallel table rather than altering Knex's schema so its migrator
 * stays untouched and upgradable.
 *
 * Writes happen inside the same Knex transaction as the migration itself,
 * so all three writes (`parcae_migrations`, `parcae_migration_meta`, and the
 * user's schema/data changes) commit atomically. A failure in any of them
 * rolls back the whole thing.
 *
 * For `{ transaction: false }` migrations, the meta write is best-effort
 * post-commit — documented as a narrow exception users opt into.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Knex } from "knex";
import type { Engine } from "./engine";
import type { MigrationEntry } from "../routing/migration";

export const META_TABLE = "parcae_migration_meta";

export interface MigrationMetaRow {
  name: string;
  checksum: string;
  description: string | null;
  ticket: string | null;
  durationMs: number;
  appliedAt: string; // ISO 8601
}

/**
 * Create the meta table if it doesn't exist. Idempotent — safe to call on
 * every boot. Uses Knex's `hasTable` for cross-engine compatibility (SQLite,
 * Postgres, AlloyDB).
 */
export async function ensureMetaTable(db: Knex): Promise<void> {
  if (await db.schema.hasTable(META_TABLE)) return;
  await db.schema.createTable(META_TABLE, (t) => {
    t.string("name", 512).primary();
    t.string("checksum", 64).notNullable(); // sha256 hex = 64 chars
    t.text("description").nullable();
    t.string("ticket", 128).nullable();
    t.integer("durationMs").notNullable();
    // ISO string — portable across SQLite (TEXT) and Postgres (timestamp)
    t.string("appliedAt", 32).notNullable();
  });
}

/**
 * Compute the sha256 of a file's bytes, as a 64-char hex string.
 * Returns an empty string for a null/missing path — the caller treats this
 * as "unknown origin" (programmatic registration) and skips verification.
 */
export function sha256File(path: string | null): string {
  if (!path) return "";
  try {
    const buf = readFileSync(path);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return "";
  }
}

/**
 * Upsert a meta row inside the provided Knex connection (which may be a
 * transaction). Uses `onConflict().merge()` so retries after partial failures
 * don't throw on duplicate keys.
 */
export async function writeMetaRow(
  db: Knex,
  row: MigrationMetaRow,
): Promise<void> {
  await db(META_TABLE)
    .insert(row)
    .onConflict("name")
    .merge();
}

/**
 * Read all meta rows, keyed by migration name.
 */
export async function readMetaRows(
  db: Knex,
): Promise<Map<string, MigrationMetaRow>> {
  if (!(await db.schema.hasTable(META_TABLE))) return new Map();
  const rows = await db<MigrationMetaRow>(META_TABLE).select("*");
  return new Map(rows.map((r) => [r.name, r]));
}

/**
 * Thrown when an already-applied migration's source file no longer matches
 * the checksum recorded when it was first applied. Separate class so callers
 * can `instanceof`-match and decide whether to surface, bypass, or exit.
 */
export class MigrationChecksumError extends Error {
  constructor(
    public readonly drifted: Array<{
      name: string;
      expected: string;
      actual: string;
    }>,
  ) {
    const lines = drifted
      .map(
        (d) =>
          `  - ${d.name}\n      expected: ${d.expected}\n      actual:   ${d.actual}`,
      )
      .join("\n");
    super(
      `[parcae] migration checksum drift — ${drifted.length} migration(s) ` +
        `have been edited after they were applied:\n${lines}\n\n` +
        `Revert the edits or, if you know what you're doing, rerun with ` +
        `--allow-checksum-drift (CLI) or ` +
        `PARCAE_ALLOW_CHECKSUM_DRIFT=true (app startup).`,
    );
    this.name = "MigrationChecksumError";
  }
}

/**
 * Compare each already-applied migration's current file content against
 * the recorded checksum. Throws `MigrationChecksumError` on any mismatch
 * unless `allowDrift` is true.
 *
 * Entries without a `path` (programmatic registration) are skipped — there
 * is no source file to hash.
 *
 * Entries that are recorded as applied but whose files no longer exist are
 * **not** treated as drift — they're orphans, handled by `migrate:list`.
 */
export function verifyChecksums(
  entries: readonly MigrationEntry[],
  meta: Map<string, MigrationMetaRow>,
  allowDrift: boolean,
): void {
  if (allowDrift) return;

  const drifted: Array<{ name: string; expected: string; actual: string }> = [];

  for (const entry of entries) {
    const recorded = meta.get(entry.name);
    if (!recorded) continue; // not applied yet
    if (!entry.path) continue; // programmatic — no source to check
    if (!recorded.checksum) continue; // baselined without checksum — skip

    const actual = sha256File(entry.path);
    if (actual && actual !== recorded.checksum) {
      drifted.push({
        name: entry.name,
        expected: recorded.checksum,
        actual,
      });
    }
  }

  if (drifted.length > 0) {
    throw new MigrationChecksumError(drifted);
  }
}

/**
 * Descriptor used by `migrate:list` to classify every migration's state.
 */
export type MigrationState = "applied" | "pending" | "orphan" | "drift";

export interface MigrationListing {
  name: string;
  state: MigrationState;
  description: string | null;
  ticket: string | null;
  durationMs: number | null;
  appliedAt: string | null;
  path: string | null;
}

/**
 * Combine the registry, Knex's applied-migrations view, and the meta table
 * into a single list of migration descriptors — the canonical input for
 * `migrate:list` / `migrate:status`.
 */
export function buildListing(
  entries: readonly MigrationEntry[],
  applied: Set<string>,
  meta: Map<string, MigrationMetaRow>,
): MigrationListing[] {
  const result: MigrationListing[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    seen.add(entry.name);
    const metaRow = meta.get(entry.name);
    let state: MigrationState;
    if (!applied.has(entry.name)) {
      state = "pending";
    } else if (
      entry.path &&
      metaRow?.checksum &&
      sha256File(entry.path) !== metaRow.checksum
    ) {
      state = "drift";
    } else {
      state = "applied";
    }
    result.push({
      name: entry.name,
      state,
      description: entry.description ?? metaRow?.description ?? null,
      ticket: entry.ticket ?? metaRow?.ticket ?? null,
      durationMs: metaRow?.durationMs ?? null,
      appliedAt: metaRow?.appliedAt ?? null,
      path: entry.path,
    });
  }

  // Orphans — applied in the DB but no file on disk. `meta` may or may not
  // have a row (baselined entries might not).
  for (const name of applied) {
    if (seen.has(name)) continue;
    const metaRow = meta.get(name);
    result.push({
      name,
      state: "orphan",
      description: metaRow?.description ?? null,
      ticket: metaRow?.ticket ?? null,
      durationMs: metaRow?.durationMs ?? null,
      appliedAt: metaRow?.appliedAt ?? null,
      path: null,
    });
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export const ENGINES_SUPPORTED: readonly Engine[] = [
  "sqlite",
  "postgres",
  "alloydb",
];
