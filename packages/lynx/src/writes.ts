/**
 * A page's kept changes: applied at once, laid over what the page draws, handed to the engine,
 * settled here when the engine tells the page.
 *
 * A kept change is the adapter's request for it. The page that kept a change merges its answer,
 * or takes it back and records the refusal; every other page lands or drops it as the engine says.
 * Row data is written only through `stage` and the server merge, never in place.
 */

import {
  same,
  Model,
  patched,
  generateId,
  pointerSegments,
  SYM_SERVER_MERGE,
  type PatchOp,
  type WireRequest,
} from "@parcae/model";

import { page } from "./page";
import type { WriteOutcome, WriteRefusal } from "./queue";
import { listKeyOf, retainedHolders, type LiveRow, type LiveQueryStore } from "./live-query";
import { keyOf, typeOf, recordOf, holdersOf, type ServerRow, type StoredWrite } from "./rows";

/** The engine's waiting changes as it last told this page; none on the main thread. */
let waiting: readonly StoredWrite[] = [];
/** This page's records for the changes it kept, and the stores a create was listed in. */
const own      = new Map<string, { record: Model; stores: LiveQueryStore<any>[] }>();
/** Another page's waiting creates, hydrated once each. */
const created  = new Map<string, LiveRow | null>();
const refusals = new WeakMap<Model, WriteRefusal>();
const watched  = new WeakSet<Model>();

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
  const { adapter } = page().client;
  return {
    patch(ops) {
      record.stage(ops);
      return start(record, adapter.request(record, "patch", ops));
    },
    save(...stores) {
      // A later patch or remove reaches the row by this id while the create still waits.
      record.tmp ??= record.id;
      for (const store of stores) store.addOptimistic(record);
      return start(record, adapter.request(record, "save", record.__data), stores);
    },
    remove() {
      return start(record, adapter.request(record, "remove"));
    },
  };
}

export function refusalOf(record: Model): WriteRefusal | null {
  return refusals.get(record) ?? null;
}

function start(record: Model, request: WireRequest, stores: LiveQueryStore<any>[] = []): Promise<void> {
  "background only";
  const write: StoredWrite = {
    ...request,
    key   : generateId(),
    type  : typeOf(record),
    id    : record.id,
    lists : stores.flatMap((store) => listKeyOf(store) ?? []),
    kept  : Date.now(),
    sent  : null,
  };
  refusals.delete(record);
  own.set(write.key, { record, stores });
  return page().keep(write);
}

// =============================================================================
// Settle
// =============================================================================

/** This card's `PageHooks.moved`: the engine's waiting changes moved, settling `outcome`'s when given. */
export function moved(outcome: WriteOutcome | null): void {
  waiting = page().waiting();
  if (outcome) {
    const { write } = outcome;
    const mine = own.has(write.key);
    if ("refusal" in outcome) {
      const record = undo(write);
      if (mine && record) refusals.set(record, outcome.refusal);
    } else if (mine) {
      settle(write, outcome.answer);
    } else {
      settledElsewhere(write);
    }
  }
  for (const write of waiting) {
    const record = own.get(write.key)?.record ?? recordOf(write.type, write.id);
    if (record) layOver([record]);
  }
  for (const holder of retainedHolders()) holder.republish();
}

function settle(write: StoredWrite, answer: ServerRow | null): void {
  const record = forget(write);
  if (write.method === "DELETE") {
    unlist(write, record);
  } else if (record && answer) {
    // A write's answer carries no derived field, so it merges over the fields it has.
    record[SYM_SERVER_MERGE]({ ...record.__serverSnapshot, ...answer });
    record.__isNew = false;
    layOver([record]);
  }
}

/**
 * Another page's change: here it counts as landed until the record's next answer says otherwise,
 * so a delete leaves the page's lists and a patch's fields stay.
 */
function settledElsewhere(write: StoredWrite): void {
  const record = forget(write);
  if (write.method === "DELETE") unlist(write, record);
  else if (write.method === "PATCH" && record) record[SYM_SERVER_MERGE](patched(record.__serverSnapshot, heldOps(record, write)));
}

/**
 * A deleted record leaves every open store, where a create the server hasn't echoed is only an
 * optimistic row, and every store that holds it, released ones too, so a list reopened later
 * doesn't show it again.
 */
function unlist(write: StoredWrite, record: Model | undefined): void {
  for (const id of new Set([write.id, record?.id ?? write.id]))
    for (const holder of new Set([...retainedHolders(), ...holdersOf(write.type, id)])) holder.unlist(id);
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
  return record;
}

function forget(write: StoredWrite): Model | undefined {
  const record = own.get(write.key)?.record ?? recordOf(write.type, write.id);
  own.delete(write.key);
  created.delete(write.key);
  return record;
}

// =============================================================================
// The page's view
// =============================================================================

/** A patch's ops on the fields `record` holds; the others it never drew. */
function heldOps(record: Model, write: StoredWrite): PatchOp[] {
  return (write.body.ops as PatchOp[]).filter((op) => Object.hasOwn(record.__serverSnapshot, pointerSegments(op.path)[0]!));
}

/** Stages each held record's waiting patch ops on the fields it holds, and again after another write's answer drops them. */
export function layOver(records: readonly LiveRow[]): void {
  for (const record of records) {
    if (!(record instanceof Model)) continue;
    const key = keyOf(record);
    const ops = waiting
      .filter((write) => write.method === "PATCH" && `${write.type}:${write.id}` === key)
      .flatMap((write) => heldOps(record, write));
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
