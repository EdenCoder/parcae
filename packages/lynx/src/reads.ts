/**
 * The app's live reads: the server's rows as sent, counted across pages, patched in place, kept a
 * grace after the last page lets go, and the only writer of answers to storage. Its state is live
 * only in the host's copy of this module; page files reach it through `page()`, never by import.
 */

/// <reference types="@lynx-js/types" />

import type { ParcaeClient } from "@parcae/sdk";
import { patched, holdings, heldInOrder, type PatchOp, type QueryStep } from "@parcae/model";

import { fieldsOf, drawnRow, storedRow, sharesRecords, type ServerRow, type StoredList, type RowStorage, type AnsweredRow } from "./rows";
import type { LiveStatus } from "./live-query";

/** A read as a page asks for it: plain data. */
export interface ReadRequest {
  /** Its list in storage: model type and steps, plus ":nosub" when it doesn't subscribe. */
  key       : string;
  type      : string;
  /** Every `select` names `updatedAt`, so `have` names every row the read holds. */
  steps     : readonly QueryStep[];
  subscribe : boolean;
  /** The records it is expected to hold, drawn from storage before its own list is kept. */
  ids       : readonly string[];
}

/** A store's side of a read it retains. */
export interface ReadView {
  changed(read: Read): void;
  /** Whether an answer goes to storage; asked only while this store retains the read. */
  keeps?(rows: readonly ServerRow[]): boolean;
}

/** One read for every page on it. */
export interface Read {
  /** In the server's order; a row a patch moved is a new object, an unmoved one the same. */
  rows    : readonly ServerRow[];
  total   : number;
  status  : LiveStatus;
  error   : Error | null;
  /** Times the read was brought current. */
  answers : number;
  drawn   : boolean;
  /** Subscribed, with nothing missed since its last answer. */
  live    : boolean;
}

interface Entry extends Read {
  request    : ReadRequest;
  fields     : ReadonlySet<string> | null;
  views      : Set<ReadView>;
  hash       : string | null;
  stopHearing: (() => void) | null;
  /** Bumped by each ask and stop; an answer to an older one is dropped. */
  asked      : number;
  /** An ask is on its way. */
  inflight   : boolean;
  /** The next ask sends no `have`: the last answer named a row neither side had. */
  whole      : boolean;
  /** The account storage kept the drawn rows for, until the server answers. */
  storedUser : string | null;
  /** The versions the drawn rows hold for this read's fields, until the server answers. */
  held       : Record<string, string> | null;
  storageRead: boolean;
  /** Storage's answer on its way; the read asks the server once it has drawn. */
  storing    : Promise<void> | null;
  grace      : ReturnType<typeof setTimeout> | null;
}

type QueryOp =
  | { op: "add"; id: string; data?: ServerRow }
  | { op: "remove"; id: string }
  | { op: "update"; id: string; patch?: PatchOp[] };

/** How long a read nothing retains stays subscribed: the web's GC_DELAY. */
const READ_GRACE_MS = 60_000;

let client  : ParcaeClient;
let storage : RowStorage | null = null;

const reads = new Map<string, Entry>();

/** Whether the session has settled, so reads may ask the server. */
let ready = false;
/** The account the settled session reads as; null while it settles or reads anonymously. */
let readAs: string | null = null;

export function startReads(engineClient: ParcaeClient, engineStorage: RowStorage | null): void {
  client  = engineClient;
  storage = engineStorage;
}

/** Calls a page's code from the engine; a page's throw is reported, and other pages go on. */
export function guarded(call: () => void): void {
  try {
    call();
  } catch (error) {
    lynx.reportError(error as Error);
  }
}

// =============================================================================
// Retain
// =============================================================================

/** `view` holds the read until released; a live read draws at once, any other draws what storage kept, then asks the server. */
export function retainRead(request: ReadRequest, view: ReadView): () => void {
  const entry = reads.get(request.key) ?? open(request);
  if (entry.grace) clearTimeout(entry.grace);
  entry.grace = null;
  entry.views.add(view);
  if (entry.drawn) guarded(() => view.changed(entry));
  readStored(entry);
  if (!entry.live && !entry.inflight) ask(entry);
  return () => {
    if (!entry.views.delete(view) || entry.views.size > 0) return;
    entry.grace = setTimeout(() => close(entry), READ_GRACE_MS);
  };
}

/** Asks the server again; only rows that moved come back. */
export function refetchRead(key: string): void {
  const entry = reads.get(key);
  if (entry?.views.size) ask(entry);
}

/** A create the server took joins the reads it was listed in that don't hold it yet; the server's own `add` is the read's shape. */
export function listCreated(keys: readonly string[], row: ServerRow): void {
  const id = String(row.id);
  for (const key of keys) {
    const entry = reads.get(key);
    if (entry && !entry.rows.some((held) => held.id === id)) applyOps(entry, [{ op: "add", id, data: row }]);
  }
}

/** The socket came back: every retained read asks again; the rest are no longer live. */
export function resyncReads(): void {
  for (const entry of reads.values()) {
    if (entry.views.size) ask(entry);
    else stop(entry);
  }
}

/** The line dropped: nothing is live until it answers again. */
export function lostReads(): void {
  for (const entry of reads.values()) entry.live = false;
}

/**
 * The session settled as `userId` (`isReady`) or is settling. Rows were read as someone else, so
 * they go, except rows drawn from storage for the account the session may still settle on.
 */
export function resetReads(isReady: boolean, userId: string | null): void {
  ready  = isReady;
  readAs = isReady ? userId : null;
  for (const entry of reads.values()) {
    stop(entry);
    if (!entry.views.size) {
      close(entry);
      continue;
    }
    if (entry.storedUser === null || (isReady && entry.storedUser !== userId)) {
      Object.assign(entry, { rows: [], total: 0, status: "loading", error: null, drawn: false, storageRead: false, storedUser: null, held: null });
    }
    notify(entry);
    readStored(entry);
    ask(entry);
  }
}

function open(request: ReadRequest): Entry {
  const entry: Entry = {
    request,
    fields      : fieldsOf(request.steps),
    views       : new Set(),
    rows        : [],
    total       : 0,
    status      : "loading",
    error       : null,
    answers     : 0,
    drawn       : false,
    live        : false,
    hash        : null,
    stopHearing : null,
    asked       : 0,
    inflight    : false,
    whole       : false,
    storedUser  : null,
    held        : null,
    storageRead : false,
    storing     : null,
    grace       : null,
  };
  reads.set(request.key, entry);
  return entry;
}

function close(entry: Entry): void {
  stop(entry);
  reads.delete(entry.request.key);
}

function notify(entry: Entry): void {
  for (const view of entry.views) guarded(() => view.changed(entry));
}

// =============================================================================
// Ask
// =============================================================================

/**
 * Asks the server for a retained `entry` on its own, so a refusal is only its own, once storage
 * has drawn, so the ask says what it holds. `resync` answers a read its scope refuses as empty.
 * The client keeps the server's subscriptions until the answer has attached or been dropped.
 */
function ask(entry: Entry): void {
  if (!ready || !entry.views.size) return;
  entry.inflight = true;
  if (entry.storing) {
    void entry.storing.then(() => ask(entry));
    return;
  }
  const { request } = entry;
  const have = entry.drawn && !entry.whole ? (entry.held ?? holdings(entry.rows, request.steps as QueryStep[])) : null;
  const at = ++entry.asked;
  entry.whole = false;
  void client.withQuerySubscriptions(() =>
    client
      .resync([
        {
          key       : request.key,
          modelType : request.type,
          steps     : [...request.steps],
          ...(request.subscribe ? {} : { subscribe: false }),
          ...(have ? { have } : {}),
        },
      ])
      .then((results) => {
        const result = results[0]!;
        if (entry.asked !== at) return;
        entry.inflight = false;
        const rows = result.ids ? heldInOrder(entry.rows, result.items as ServerRow[], result.ids) : result.items;
        if (!rows) {
          entry.whole = true;
          ask(entry);
          return;
        }
        Object.assign(entry, {
          rows,
          total      : result.totalCount,
          status     : "ready",
          error      : null,
          answers    : entry.answers + 1,
          drawn      : true,
          storedUser : null,
          held       : null,
        });
        attach(entry, result.hash);
        entry.live = !!result.hash;
        client._emitDiagnostic?.("answer", {});
        keepAnswer(entry);
        notify(entry);
      })
      .catch((error: Error) => {
        if (entry.asked !== at) return;
        entry.inflight = false;
        entry.error  = error;
        entry.status = entry.answers && entry.rows.length ? "ready" : "error";
        notify(entry);
      }),
  );
}

// =============================================================================
// Subscriptions
// =============================================================================

/** The read hears its hash; the hash is the server's, and reads with the same SQL share it. */
function attach(entry: Entry, hash: string | null): void {
  if (entry.hash === hash) return;
  detach(entry);
  if (!hash) return;
  entry.hash = hash;
  entry.stopHearing = client.subscribe(`query:${hash}`, (payload: unknown) => {
    const p = payload as { ops?: QueryOp[]; order?: string[] } | QueryOp[];
    const ops = Array.isArray(p) ? p : (p?.ops ?? []);
    const order = Array.isArray(p) ? undefined : p?.order;
    applyOps(entry, ops, order);
  });
}

/** The read is no longer live, and an answer on its way is dropped. */
function stop(entry: Entry): void {
  entry.live = false;
  entry.asked++;
  entry.inflight = false;
  detach(entry);
}

/** The read stops hearing its hash; the client lets the server go once no read hears it. */
function detach(entry: Entry): void {
  entry.stopHearing?.();
  entry.stopHearing = null;
  entry.hash = null;
}

function applyOps(entry: Entry, ops: readonly QueryOp[], order?: readonly string[]): void {
  let rows = entry.rows;
  for (const op of ops) {
    const at = rows.findIndex((row) => row.id === op.id);
    if (op.op === "remove" && at >= 0) {
      rows = rows.filter((row) => row.id !== op.id);
    } else if (op.op === "add" && op.data) {
      // The server's add is the row as this read selects it, over a create's own answer.
      rows = at < 0 ? [...rows, op.data] : rows.map((each, index) => (index === at ? op.data! : each));
    } else if (op.op === "update" && op.patch && at >= 0) {
      const row = patched(rows[at]!, op.patch);
      rows = rows.map((each, index) => (index === at ? row : each));
    }
  }
  if (order) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const next = order.flatMap((id): ServerRow[] => (byId.has(id) ? [byId.get(id)!] : []));
    rows = [...next, ...rows.filter((row) => !order.includes(row.id as string))];
  }
  if (rows === entry.rows) return;
  entry.rows = rows;
  entry.answers++;
  keepAnswer(entry);
  notify(entry);
}

// =============================================================================
// Storage
// =============================================================================

/**
 * A stored answer draws once, only while the server hasn't, and only for the account the session
 * may settle on; the read's first ask says it holds only the rows storage vouches for at its fields.
 */
function readStored(entry: Entry): void {
  const { request } = entry;
  if (!storage || entry.drawn || entry.storageRead || !sharesRecords(entry.fields)) return;
  entry.storageRead = true;
  entry.storing = storage
    .read({ type: request.type, key: request.key, ids: request.ids })
    .then(({ user, list: kept, rows }) => {
      if (entry.drawn || !user || (ready && user !== readAs)) return;
      const data = new Map(rows.map((row) => [row.id, row.data]));
      const order: string[] = kept ? JSON.parse(kept.ids) : [...request.ids];
      // A kept list draws whole or not at all: one missing a row waits for the server.
      if (kept && !order.every((id) => data.has(id))) return;
      const drawn = order.flatMap((id) => (data.has(id) ? [drawnRow(data.get(id)!, entry.fields)] : []));
      // A kept list is an answer even when empty; ids alone draw only what they find.
      if (!kept && drawn.length === 0) return;
      const found = drawn.map(({ row }) => row);
      const held = Object.fromEntries(drawn.flatMap(({ row, held }) => (held === undefined ? [] : [[String(row.id), held]])));
      Object.assign(entry, { rows: found, total: kept?.total ?? found.length, drawn: true, storedUser: user, held });
      notify(entry);
    })
    .catch((error: Error) => {
      if (entry.answers) return;
      entry.error = error;
      notify(entry);
    })
    .finally(() => {
      entry.storing = null;
    });
}

/** Every answer the read's stores all keep is stored whole, rows and list, as the account read as. */
function keepAnswer(entry: Entry): void {
  if (!storage || !readAs || !entry.views.size || !sharesRecords(entry.fields)) return;
  if ([...entry.views].some((view) => view.keeps?.(entry.rows) === false)) return;
  const ids = JSON.stringify(entry.rows.map((row) => row.id));
  const versions = holdings(entry.rows, entry.request.steps as QueryStep[]);
  writeRows(readAs, entry.rows, entry.fields, versions, { key: entry.request.key, type: entry.request.type, ids, total: entry.total });
}

let pending: { user: string; rows: AnsweredRow[]; lists: Map<string, StoredList> } | null = null;

/** Keeps the read's own fields of an answer's `rows` at their `versions`, and its list, as `user` read them; one batch per tick. */
function writeRows(user: string, rows: readonly ServerRow[], fields: ReadonlySet<string> | null, versions: Record<string, string>, list: StoredList): void {
  if (pending && pending.user !== user) flush();
  if (!pending) {
    pending = { user, rows: [], lists: new Map() };
    setTimeout(flush, 0);
  }
  for (const row of rows) pending.rows.push(storedRow(list.type, row, fields, versions[String(row.id)]));
  pending.lists.set(list.key, list);
}

function flush(): void {
  const batch = pending;
  pending = null;
  if (!batch || !storage) return;
  void storage.write({ user: batch.user, rows: batch.rows, lists: [...batch.lists.values()] });
}
