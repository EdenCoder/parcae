/**
 * The page's rows: one object per record, and the slot where the app keeps earlier ones.
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

/** Where a page's earlier rows are kept. The app owns custody, as it owns the token. */
export interface RowStorage {
  /** The kept list `key` names and the rows of `type` it lists, plus `ids`, for the account the phone is signed in as. */
  read(request: { type: string; key: string; ids: readonly string[] }): Promise<{
    user: string | null;
    list: StoredList | null;
    rows: StoredRow[];
  }>;
  /**
   * Keeps rows and lists read as `user`, in order; storage drops a batch for any other account.
   * A row with `fields` rewrites those fields of the kept row, `$field` ids included, and keeps
   * the rest; a row without replaces it. Keeps `writes` by key, in their place, and drops the
   * `settled` keys. Resolves once kept.
   */
  write(batch: {
    user     : string;
    rows     : readonly AnsweredRow[];
    lists    : readonly StoredList[];
    writes?  : readonly StoredWrite[];
    settled? : readonly string[];
  }): Promise<void>;
  /** The account's waiting changes, oldest first. */
  waiting(): Promise<{ user: string | null; writes: StoredWrite[] }>;
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

let storage: RowStorage | null = null;

export function provideRowStorage(next: RowStorage | null): void {
  storage = next;
}

export function rowStorage(): RowStorage | null {
  return storage;
}

let pending: { user: string; rows: AnsweredRow[]; lists: Map<string, StoredList> } | null = null;

/** Keeps the read's own fields of an answer's `rows`, and its list, as `user` read them; one batch per tick. */
export function writeRows(
  user: string,
  rows: readonly ServerRow[],
  fields: ReadonlySet<string> | null,
  list: StoredList,
): void {
  if (!storage) return;
  if (pending && pending.user !== user) flush();
  if (!pending) {
    pending = { user, rows: [], lists: new Map() };
    setTimeout(flush, 0);
  }
  for (const row of rows) {
    const data = JSON.stringify(fields ? ownFields(row, fields) : row);
    pending.rows.push({ type: list.type, id: String(row.id), data, fields: fields && [...fields] });
  }
  pending.lists.set(list.key, list);
}

function flush(): void {
  const batch = pending;
  pending = null;
  if (!batch || !storage) return;
  void storage.write({ user: batch.user, rows: batch.rows, lists: [...batch.lists.values()] });
}

// =============================================================================
// Records
// =============================================================================

const records = new Map<string, { row: LiveRow; holders: Set<Holder> }>();
const held = new Map<Holder, Set<string>>();

/** The columns a read asked for, or null when it reads whole rows. */
export function fieldsOf(steps: readonly { method: string; args: unknown[] }[] = []): ReadonlySet<string> | null {
  const selected = steps.filter((step) => step.method === "select").flatMap((step) => step.args.flat());
  if (selected.length === 0) return null;
  return new Set([...selected.filter((field) => typeof field === "string"), ...extractExpandFields(steps as never)]);
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
