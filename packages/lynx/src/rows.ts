/**
 * The page's rows: one object per record, and the shapes storage keeps them in.
 *
 * Every live query store in a page hands out the same object for the same record, its model type
 * and id. A read that selects columns without `id` mints local ids and shares nothing. An answer
 * rewrites exactly the fields its read asked for, in the page and in storage: with a `select`, a
 * selected field the server's row lacks is removed and the others stay; without one, the whole row
 * is authoritative.
 */

import { Model, SYM_VERSION, SYM_SERVER_MERGE, extractExpandFields, type WireRequest } from "@parcae/model";

import type { LiveRow } from "./live-query";

/** A row as the server sent it: its fields, with joined references nested beside their `$field` ids. */
export type ServerRow = Record<string, unknown>;

/** A row as storage keeps it: `data` is the server's row as JSON. */
export interface StoredRow {
  type: string;
  id: string;
  data: string;
}

/** An answer's row for storage: `fields` names the columns its read asked for, null for a whole row. */
export interface AnsweredRow extends StoredRow {
  fields: readonly string[] | null;
}

/** A query's answer as storage keeps it: its rows' ids in order, as JSON, and its total. */
export interface StoredList {
  key: string;
  type: string;
  ids: string;
  total: number;
}

/**
 * Where the app's earlier rows are kept. The app owns custody, as it owns the token. Every request
 * names the format (`STORAGE_FORMAT`) it reads or writes.
 */
export interface RowStorage {
  /** The kept list `key` names and the rows of `type` it lists, plus `ids`, for the account the phone is signed in as. */
  read(request: { type: string; key: string; ids: readonly string[]; format: number }): Promise<{
    user: string | null;
    list: StoredList | null;
    rows: StoredRow[];
  }>;
  /**
   * Keeps rows and lists read as `user`, in order; storage drops a batch for any other account.
   * A row with `fields` rewrites those fields of the kept row, `$field` ids included, and keeps
   * the rest; a row without replaces it. Drops the `removed` rows. Keeps `writes` by key, in
   * their place, and drops the `settled` keys. Resolves once kept.
   */
  write(batch: RowBatch): Promise<void>;
  /** The account's waiting changes, oldest first. */
  waiting(request: { format: number }): Promise<{ user: string | null; writes: StoredWrite[] }>;
}

/** What `RowStorage.write` keeps in one go. */
export interface RowBatch {
  format   : number;
  user     : string;
  rows     : readonly AnsweredRow[];
  lists    : readonly StoredList[];
  removed? : readonly { type: string; id: string }[];
  writes?  : readonly StoredWrite[];
  settled? : readonly string[];
}

/** A change as storage keeps it until the server answers: its request, and where a create shows. */
export interface StoredWrite extends WireRequest {
  /** Its id in storage, sent as its idempotency key. */
  key    : string;
  type   : string;
  /** The record's id; a create's own id, which it is also saved under as `tmp`. */
  id     : string;
  /** The stored lists (`StoredList.key`) a create is listed in until it's answered. */
  lists  : readonly string[];
  /** When it was kept, in ms; every report's wait counts from here. */
  kept   : number;
  /** When it was first sent, in ms; null while it never has been. */
  sent   : number | null;
}

/** A store that lists records, redrawn when another store's answer changes one. */
export interface Holder {
  republish(): void;
  /** Leaves the record with `id` out of the store's rows. */
  unlist(id: string): void;
}

// =============================================================================
// Storage
// =============================================================================

/**
 * The version of the rows and lists storage keeps (`StoredRow`, `StoredList`, the held key, a
 * list's key); raise it when one changes, or a field of a model a kept row holds, and storage
 * holding another drops them. The waiting changes outlive every format, so `StoredWrite` stays
 * readable by every later build.
 */
export const STORAGE_FORMAT = 1;

/**
 * Where a stored row keeps the version a read answered it at, named by that read's fields: another
 * read rewrites only its own fields, so the row's `updatedAt` vouches for none but its own.
 */
const heldKey = (fields: ReadonlySet<string> | null) => `__held:${fields ? [...fields].sort().join() : "*"}`;

/** `row` as storage keeps it: the fields its read asked for, or the whole row, with the `version` its read holds it at. */
export function storedRow(type: string, row: ServerRow, fields: ReadonlySet<string> | null, version?: string): AnsweredRow {
  const kept = fields ? ownFields(row, fields) : { ...row };
  if (version !== undefined) kept[heldKey(fields)] = version;
  return { type, id: String(row.id), data: JSON.stringify(kept), fields: fields && [...fields] };
}

/**
 * A stored row as a read of `fields` draws it, and the version it holds for them: only a read of the
 * same fields vouches, since a whole row lacks the derived fields a read names (`parts`).
 */
export function drawnRow(data: string, fields: ReadonlySet<string> | null): { row: ServerRow; held?: string } {
  const row = JSON.parse(data) as ServerRow;
  const held = row[heldKey(fields)];
  for (const key of Object.keys(row)) if (key.startsWith("__held:")) delete row[key];
  return { row, held: typeof held === "string" ? held : undefined };
}

// =============================================================================
// Records
// =============================================================================

const records = new Map<string, { row: LiveRow; holders: Set<Holder> }>();
const held = new Map<Holder, Set<string>>();

/**
 * The fields a read asked for; null when it reads whole rows. A picked derived field (`parts.text`)
 * is held and stored as its whole field, so an app's reads pick one set of kinds per field.
 */
export function fieldsOf(steps: readonly { method: string; args: unknown[] }[] = []): ReadonlySet<string> | null {
  const selected = steps.filter((step) => step.method === "select").flatMap((step) => step.args.flat());
  if (selected.length === 0) return null;
  const named = [...selected.filter((field) => typeof field === "string"), ...extractExpandFields(steps as never)];
  return new Set(named.map((field) => field.split(".")[0]!));
}

/** Whether a read's rows are records: whole rows, or a selection that includes `id`. */
export function sharesRecords(fields: ReadonlySet<string> | null): boolean {
  return !fields || fields.has("id");
}

/** The page's object for `row`'s record, when a store holds one and this read shares records. */
export function recordFor<T extends LiveRow>(row: T, fields: ReadonlySet<string> | null): T | undefined {
  const key = sharesRecords(fields) ? keyOf(row) : null;
  return key ? (records.get(key)?.row as T | undefined) : undefined;
}

/** The page's object for the record `type` and `id`, while a store holds it. */
export function recordOf(type: string, id: string): Model | undefined {
  return records.get(`${type}:${id}`)?.row as Model | undefined;
}

/** The stores that list the record `type` and `id`, retained or not. */
export function holdersOf(type: string, id: string): Holder[] {
  return [...(records.get(`${type}:${id}`)?.holders ?? [])];
}

/** `holder` now lists `rows`; a record lives while some store lists it. */
export function hold(holder: Holder, rows: readonly LiveRow[], fields: ReadonlySet<string> | null): void {
  const keys = new Set<string>();
  for (const row of sharesRecords(fields) ? rows : []) {
    const key = keyOf(row);
    if (!key) continue;
    keys.add(key);
    const entry = records.get(key) ?? { row, holders: new Set<Holder>() };
    entry.holders.add(holder);
    records.set(key, entry);
  }
  for (const key of held.get(holder) ?? []) {
    const entry = records.get(key);
    if (keys.has(key) || !entry) continue;
    entry.holders.delete(holder);
    if (entry.holders.size === 0) records.delete(key);
  }
  held.set(holder, keys);
}

/** Every record goes: the rows were read as another account. Stores that keep rows hold them again. */
export function forgetRecords(): void {
  records.clear();
  held.clear();
}

/** Merges an answer's row (`fresh` hydrated from `row`) into the page's object over exactly the fields its read asked for. */
export function mergeRow(
  existing: LiveRow,
  fresh: LiveRow,
  row: ServerRow,
  fields: ReadonlySet<string> | null,
  by: Holder,
): void {
  const merge = existing[SYM_SERVER_MERGE];
  if (!(existing instanceof Model) || typeof merge !== "function") {
    const data = fresh instanceof Model ? fresh : (fresh.__data ?? { ...fresh });
    if (typeof merge === "function") merge.call(existing, data as Record<string, unknown>);
    else Object.assign(existing, data);
    return;
  }
  const version = existing[SYM_VERSION];
  merge.call(existing, fields ? { ...unasked(existing, fields), ...ownFields(row, fields) } : (fresh as never));
  if (existing[SYM_VERSION] === version) return;
  for (const holder of records.get(keyOf(existing) ?? "")?.holders ?? []) {
    if (holder !== by) holder.republish();
  }
}

/** The server's last view of the fields a read didn't ask for. */
function unasked(existing: Model, fields: ReadonlySet<string>): ServerRow {
  return Object.fromEntries(Object.entries(existing.__serverSnapshot).filter(([key]) => !fields.has(key)));
}

/** The fields of `row` its read asked for, each joined reference with its `$field` id. */
function ownFields(row: ServerRow, fields: ReadonlySet<string>): ServerRow {
  return Object.fromEntries(Object.entries(row).filter(([key]) => fields.has(key.replace(/^\$/, ""))));
}

export function typeOf(row: Model): string {
  return (row.constructor as unknown as { type: string }).type;
}

export function keyOf(row: LiveRow): string | null {
  return row instanceof Model && row.id ? `${typeOf(row)}:${row.id}` : null;
}
