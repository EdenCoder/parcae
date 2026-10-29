/**
 * A page's kept changes: stored, laid over what the page draws, sent oldest first with their key,
 * settled by the server's answer, and reported at each step.
 *
 * A kept change is its request. Every page reads the account's waiting changes from storage and
 * lays them over the records it holds until the server answers. Only an answer with a status
 * settles a change; a lost line, WRITE_RUNNING or an unreconciled socket means try again. Row data
 * is written only through `stage` and the server merge, never in place.
 */

import {
  same,
  Model,
  patched,
  generateId,
  WRITE_RUNNING,
  isNotFoundError,
  pointerSegments,
  SYM_SERVER_MERGE,
  IDEMPOTENCY_TTL_MS,
  SOCKET_NOT_RECONCILED,
  type PatchOp,
  type TransportError,
} from "@parcae/model";

import { requireClient } from "./client-registry";
import { listKeyOf, retainedHolders, type LiveRow, type LiveQueryStore } from "./live-query";
import { keyOf, typeOf, recordOf, rowStorage, type RowStorage, type StoredWrite } from "./rows";

/** The server's refusal of the last change kept for a record in this page, until another is kept. `status` is absent when the phone refused it itself. */
export interface WriteRefusal {
  method  : StoredWrite["method"];
  status? : number;
  code?   : string;
  message : string;
}

/** What happened to a stored change, emitted on the client as "write" for the app to report. */
export interface WriteMoment {
  moment  : "sent" | "retried" | "refused";
  type    : string;
  method  : StoredWrite["method"];
  /** Since it was kept. */
  ms      : number;
  /** The server's status, when it answered. */
  status? : number;
  /** The server's code for a refusal, when it gave one. */
  code?   : string;
}

const SEND_BACKOFF_FLOOR_MS = 1_000;
const SEND_BACKOFF_CAP_MS   = 60_000;

/** The account's waiting changes as this page last read them, plus the ones it is storing. */
let waiting: StoredWrite[] = [];
const storing  = new Set<string>();
/** This page's records for the changes it kept, and the stores a create was listed in. */
const own      = new Map<string, { record: Model; stores: LiveQueryStore<any>[] }>();
/** Another page's waiting creates, hydrated once each. */
const created  = new Map<string, LiveRow | null>();
const refusals = new WeakMap<Model, WriteRefusal>();
const watched  = new WeakSet<Model>();

let epoch   = 0;
let backoff = 0;
let sending = false;
let timer: ReturnType<typeof setTimeout> | null = null;

// =============================================================================
// Keep
// =============================================================================

/**
 * The record's writes, kept until the server answers: each applies at once and resolves once it
 * can't be lost (stored, or with no storage, answered). `save` lists a new record in `stores`.
 */
export function keep<T extends Model>(record: T): {
  patch(ops: PatchOp[])                : Promise<void>;
  save(...stores: LiveQueryStore<T>[]) : Promise<void>;
  remove()                             : Promise<void>;
} {
  return {
    patch(ops) {
      record.stage(ops);
      return start(record, "PATCH", `/${record.id}`, { ops });
    },
    save(...stores) {
      // A later patch or remove reaches the row by this id while the create still waits.
      record.tmp ??= record.id;
      for (const store of stores) store.addOptimistic(record);
      return start(record, "POST", "", record.__data, stores);
    },
    remove() {
      return start(record, "DELETE", `/${record.id}`, {});
    },
  };
}

export function refusalOf(record: Model): WriteRefusal | null {
  return refusals.get(record) ?? null;
}

async function start(
  record : Model,
  method : StoredWrite["method"],
  tail   : string,
  body   : Record<string, unknown>,
  stores : LiveQueryStore<any>[] = [],
): Promise<void> {
  "background only";
  const client = requireClient();
  const write: StoredWrite = {
    key   : generateId(),
    type  : typeOf(record),
    id    : record.id,
    method,
    path  : client.adapter.resolvePath(record.constructor as never) + tail,
    body,
    lists : stores.flatMap((store) => listKeyOf(store) ?? []),
    kept  : Date.now(),
    sent  : null,
  };
  refusals.delete(record);
  own.set(write.key, { record, stores });
  waiting = [...waiting, write];
  layOver([record]);
  republish();
  const storage = rowStorage();
  const user = client.session.state.userId;
  if (!storage || !user) return settleNow(write);
  storing.add(write.key);
  try {
    await storage.write({ user, rows: [], lists: [], writes: [write] });
  } catch (cause) {
    undo(write);
    throw cause;
  } finally {
    storing.delete(write.key);
  }
  sendWrites();
}

/** With no storage, a change is sent once and answers its caller; a lost line refuses it. */
async function settleNow(write: StoredWrite): Promise<void> {
  try {
    settle(write, await send(write));
  } catch (cause) {
    refuse(write, cause as TransportError);
    throw cause;
  }
}

// =============================================================================
// Send
// =============================================================================

/**
 * Sends the oldest waiting change while a store is retained, the session signed in and the line
 * up. Only a page with open lists sends; a hidden page sends nothing.
 */
export function sendWrites(): void {
  "background only";
  const storage = rowStorage();
  if (!storage || sending || retainedHolders().length === 0) return;
  const client = requireClient();
  if (client.session.state.status !== "authenticated" || !client.isConnected) return;
  if (timer) clearTimeout(timer);
  timer = null;
  sending = true;
  const at = epoch;
  drain(storage, at)
    .catch(() => retryLater())
    .finally(() => {
      if (at === epoch) sending = false;
    });
}

async function drain(storage: RowStorage, at: number): Promise<void> {
  for (;;) {
    const { user, writes } = await storage.waiting();
    if (at !== epoch) return;
    adopt(writes);
    const write = writes[0];
    if (!write || !user) return;
    let answer: unknown;
    if (write.sent !== null && Date.now() - write.sent > IDEMPOTENCY_TTL_MS) {
      // The server may have forgotten its key, so a resend could run it twice.
      refuse(write, { message: "Kept longer than the server remembers it" });
    } else {
      if (write.sent === null)
        await storage.write({ user, rows: [], lists: [], writes: [{ ...write, sent: Date.now() }] });
      try {
        answer = await send(write);
      } catch (cause) {
        if (at !== epoch) return;
        if (again(cause as TransportError)) return retryLater(write);
        refuse(write, cause as TransportError);
      }
      if (at !== epoch) return;
      if (waiting.some((w) => w.key === write.key)) settle(write, answer);
    }
    backoff = 0;
    await storage.write({ user, rows: [], lists: [], settled: [write.key] });
  }
}

function send(write: StoredWrite): Promise<unknown> {
  const verb = write.method.toLowerCase() as "post" | "put" | "patch" | "delete";
  return requireClient()
    [verb](write.path, write.body, { idempotencyKey: write.key })
    .catch((cause: unknown) => {
      if (write.method === "DELETE" && isNotFoundError(cause)) return null;
      throw cause;
    });
}

/** Not run, try again: the line (no status), the key's first send still running, or a socket before its session. */
function again({ status, code, message }: TransportError): boolean {
  return status === undefined || code === WRITE_RUNNING || (status === 409 && message.includes(SOCKET_NOT_RECONCILED));
}

function retryLater(write?: StoredWrite): void {
  if (write) report("retried", write);
  backoff = Math.min(Math.max(backoff * 2, SEND_BACKOFF_FLOOR_MS), SEND_BACKOFF_CAP_MS);
  timer = setTimeout(() => {
    timer = null;
    sendWrites();
  }, backoff);
}

// =============================================================================
// Settle
// =============================================================================

function settle(write: StoredWrite, answer: unknown): void {
  const record = forget(write);
  if (write.method === "DELETE") {
    for (const id of new Set([write.id, record?.id])) for (const holder of retainedHolders()) if (id) holder.unlist(id);
  } else if (record && answer && typeof answer === "object") {
    record[SYM_SERVER_MERGE](answer as Record<string, unknown>);
    record.__isNew = false;
    layOver([record]);
  }
  report("sent", write);
  republish();
}

function refuse(write: StoredWrite, { status, code, message }: Partial<TransportError> & { message: string }): void {
  const record = undo(write);
  if (record) refusals.set(record, { method: write.method, status, code, message });
  report("refused", write, { status, code });
}

/** Takes a change back out of this page: a patch's record goes back to the server's copy with what still waits. */
function undo(write: StoredWrite): Model | undefined {
  const stores = own.get(write.key)?.stores ?? [];
  const record = forget(write);
  if (write.method === "PATCH" && record) {
    record[SYM_SERVER_MERGE]({ ...record.__serverSnapshot }, record.__data);
    layOver([record]);
  }
  for (const store of write.method === "POST" ? stores : []) store.removeOptimistic(write.id);
  republish();
  return record;
}

function forget(write: StoredWrite): Model | undefined {
  const record = own.get(write.key)?.record ?? recordOf(write.type, write.id);
  waiting = waiting.filter((w) => w.key !== write.key);
  own.delete(write.key);
  created.delete(write.key);
  return record;
}

/** The server's status and code go with a refusal; JSON leaves out the ones it didn't give. */
function report(moment: WriteMoment["moment"], write: StoredWrite, answer: Pick<WriteMoment, "status" | "code"> = {}): void {
  if (!rowStorage()) return;
  const payload: WriteMoment = { moment, type: write.type, method: write.method, ms: Date.now() - write.kept, ...answer };
  requireClient()._emitDiagnostic?.("write", { ...payload });
}

// =============================================================================
// The page's view
// =============================================================================

/** Reads the account's waiting changes once per tick and lays them over this page. */
let refreshing: Promise<void> | null = null;
export function refreshWrites(): Promise<void> {
  "background only";
  const storage = rowStorage();
  if (!storage) return Promise.resolve();
  const at = epoch;
  refreshing ??= storage
    .waiting()
    .then(({ writes }) => {
      if (at === epoch) adopt(writes);
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** Storage's list becomes the page's: a change that left it is undone here, a new one laid over. */
function adopt(writes: StoredWrite[]): void {
  const listed = new Set(writes.map((write) => write.key));
  const before = waiting.map((write) => write.key).join();
  for (const write of waiting) if (!listed.has(write.key) && !storing.has(write.key)) undo(write);
  const known = new Set(waiting.map((write) => write.key));
  const fresh = writes.filter((write) => !known.has(write.key));
  waiting = [...writes, ...waiting.filter((write) => !listed.has(write.key))];
  for (const write of fresh) {
    const record = recordOf(write.type, write.id);
    if (record) layOver([record]);
  }
  if (waiting.map((write) => write.key).join() !== before) republish();
}

/** Stages each held record's waiting patch ops on the fields it holds, and again after another write's answer drops them. */
export function layOver(records: readonly LiveRow[]): void {
  for (const record of records) {
    if (!(record instanceof Model)) continue;
    const key = keyOf(record);
    const ops = waiting
      .filter((write) => write.method === "PATCH" && `${write.type}:${write.id}` === key)
      .flatMap((write) => write.body.ops as PatchOp[])
      .filter((op) => Object.hasOwn(record.__serverSnapshot, pointerSegments(op.path)[0]!));
    if (ops.length === 0) continue;
    const data = record.__data;
    if (!same(data, patched(data, ops))) record.stage(ops);
    if (watched.has(record)) continue;
    watched.add(record);
    const relay = () => layOver([record]);
    record.on("patched", relay);
    record.on("saved", relay);
  }
}

/** The `type:id` keys with a waiting delete. */
export function waitingRemoves(): ReadonlySet<string> {
  return new Set(waiting.filter((w) => w.method === "DELETE").map((w) => `${w.type}:${w.id}`));
}

/** Another page's waiting creates listed in `listKey`; this page's own are already its stores' optimistic rows. */
export function waitingCreates(listKey: string, hydrate: (data: Record<string, unknown>) => LiveRow | null): LiveRow[] {
  return waiting.flatMap((write) => {
    if (write.method !== "POST" || own.has(write.key) || !write.lists.includes(listKey)) return [];
    if (!created.has(write.key)) created.set(write.key, hydrate(write.body));
    return created.get(write.key) ?? [];
  });
}

/**
 * The session settled or changed: the send in flight is dropped and the waiting changes are read
 * again. Storage answers only for the account the phone is signed in as, so the same account keeps
 * its changes and another's leave this page.
 */
export function rereadWrites(): void {
  "background only";
  epoch++;
  refreshing = null;
  sending = false;
  backoff = 0;
  if (timer) clearTimeout(timer);
  timer = null;
  void refreshWrites().then(sendWrites);
}

function republish(): void {
  for (const holder of retainedHolders()) holder.republish();
}
