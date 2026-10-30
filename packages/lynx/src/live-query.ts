/**
 * Live query stores over the Parcae wire protocol, for runtimes where
 * `@parcae/sdk/react` can't run.
 *
 * ReactLynx executes component render code on the main (Lepus) thread
 * for first paint, where the socket client doesn't exist (`'background
 * only'`), and the SDK react hooks dereference `client.session` at
 * render time. This module keeps the protocol — `find()` returns
 * `__queryHash`, the backend streams add/remove/update ops on
 * `query:${hash}` — behind a store whose client access all happens on
 * the background thread. Snapshot reads never touch the client, so a
 * main-thread render pass just sees the store's initial state.
 *
 * Stores are module-global: every component in a bundle shares one
 * subscription and one snapshot (e.g. a saved-list store can power a
 * list page and every save button at once). Separate page bundles each
 * hold their own store; the server keeps them consistent via ops.
 *
 * This file is framework-agnostic (no Lynx / React imports) so the
 * reconciliation core can be unit-tested in node. The ReactLynx hook
 * lives in `use-live-query.ts`.
 */

import { Model, patched, SYM_SERVER_MERGE, SYM_SERVER_PATCH, serializeLazyQueryArgs, type PatchOp } from "@parcae/model";

import { requireClient } from "./client-registry";
import {
  hold,
  fieldsOf,
  mergeRow,
  recordFor,
  writeRows,
  rowStorage,
  forgetRecords,
  sharesRecords,
  type Holder,
  type ServerRow,
} from "./rows";
import {
  layOver,
  sendWrites,
  rereadWrites,
  refreshWrites,
  waitingRemoves,
  waitingCreates,
} from "./writes";

export type LiveStatus = "loading" | "ready" | "error";

/**
 * `status` turns `ready` only on a server answer; rows drawn from storage come with `loading`.
 * `total` is the last answer's count, stored or the server's. Draw what a snapshot holds, and open
 * a page from a drawn row; act, charge or count only on `ready`.
 */
export interface LiveSnapshot<T> {
  items: T[];
  status: LiveStatus;
  error: Error | null;
  /** Rows the server matched at the last fetch, before any limit or offset. */
  total: number;
  /** How many answers the server has given this read, its fetches and its pushed changes; another read's answer redraws without one. */
  answers: number;
  /** `items` are an answer, the server's or a stored one, an empty answer too; until then the read holds nothing yet. */
  drawn: boolean;
}

export interface QueryChain<T> {
  /** The hydrated rows, with the server's own beside them as `__rows`. */
  find(): Promise<T[]>;
  /** A sibling chain whose `find()` leaves no server subscription behind. */
  withSubscribe?(subscribe: boolean): QueryChain<T>;
  // ModelConstructor's static side is type-erased at the chain
  // boundary; hydrate is cast back on at the single call site.
  __modelClass?: unknown;
  __adapter?: unknown;
  __steps?: Array<{ method: string; args: unknown[] }>;
  __modelType?: string;
}

interface HydratingClass<T> {
  hydrate(adapter: unknown, data: Record<string, unknown>): T;
}

type QueryOp =
  | { op: "add"; id: string; data?: Record<string, unknown> }
  | { op: "remove"; id: string }
  | { op: "update"; id: string; patch: PatchOp[] };

export interface LiveRow {
  id?: string;
  tmp?: string;
  __data?: Record<string, unknown>;
  [SYM_SERVER_MERGE]?: (data: Record<string, unknown>) => unknown;
  [SYM_SERVER_PATCH]?: (ops: readonly PatchOp[]) => unknown;
}

export interface LiveQueryStore<T> {
  snapshot(): LiveSnapshot<T>;
  /** Subscribe + refcount. First retainer triggers the fetch, and reads storage while the store is empty. */
  retain(onChange: () => void): () => void;
  refetch(): void;
  /** Insert a locally-created row until the server echoes it back. */
  addOptimistic(item: T): void;
  removeOptimistic(id: string): void;
}

export interface LiveQueryOptions<T = LiveRow> {
  /** Hydrated rows to draw while the first subscribed fetch is in flight. */
  initial?: T[];
  /**
   * `false` reads the query without a server subscription, so no ops
   * follow it: the SDK's `useQuery({ subscribe: false })`. Default `true`.
   */
  subscribe?: boolean;
  /** The records the read is expected to hold, drawn from storage before its own list is kept. */
  ids?: readonly string[];
  /** Whether an answer goes to storage, read from its rows; storage keeps what it had for one that doesn't. */
  keeps?: (items: readonly T[]) => boolean;
}

interface StoreInternal {
  reset(refetchActive: boolean): void;
  refetchIfActive(): void;
  holder: Holder;
  /** The store's list in storage, once a background read has built its chain. */
  listKey(): string | null;
}

const registry = new Set<StoreInternal>();
let isSuspended = false;
let identityEpoch = 0;
/** The account the settled session reads as; null while it settles or reads anonymously. */
let readAs: string | null = null;

/**
 * Drop all store state (identity changed — rows belong to another user). Rows drawn from storage
 * stay while the session settles, and after only if they were kept for `userId`.
 */
export function resetLiveQueries(refetchActive = true, userId: string | null = null): void {
  "background only";
  identityEpoch++;
  isSuspended = !refetchActive;
  readAs = refetchActive ? userId : null;
  forgetRecords();
  rereadWrites();
  for (const s of registry) s.reset(refetchActive);
}

/** Re-run every active store's query (reconnect re-established the session). */
export function refetchLiveQueries(): void {
  "background only";
  if (isSuspended) return;
  for (const s of registry) s.refetchIfActive();
}

/** A read's list in storage: its model type and steps. */
function listOf(chain: QueryChain<unknown>): { key: string; type: string } | null {
  const type = chain.__modelType;
  if (!type) return null;
  const steps = (chain.__steps ?? []).map((step) => ({
    method: step.method,
    args: serializeLazyQueryArgs(step.args),
  }));
  return { key: `${type}:${JSON.stringify(steps)}`, type };
}

const internals = new WeakMap<LiveQueryStore<any>, StoreInternal>();

/** The store's list in storage; a kept create names it to show in the store from every page. */
export function listKeyOf(store: LiveQueryStore<any>): string | null {
  return internals.get(store)?.listKey() ?? null;
}

/** The holders of every retained store, redrawn when the page's waiting changes do. */
export function retainedHolders(): Holder[] {
  return [...registry].map((store) => store.holder);
}

export function createLiveQuery<T extends LiveRow>(
  chainFactory: () => QueryChain<T>,
  { subscribe = true, initial, ...options }: LiveQueryOptions<T> = {},
): LiveQueryStore<T> {
  let items: T[] = initial ?? [];
  let optimistic: T[] = [];
  let status: LiveStatus = initial ? "ready" : "loading";
  let error: Error | null = null;
  let total = items.length;
  let answers = 0;
  let snap: LiveSnapshot<T> | null = null;
  let fields: ReadonlySet<string> | null = null;
  let answered = false;
  let drawn = false;
  let storageRead = false;
  /** The account storage kept the drawn rows for, until the server answers. */
  let storedUser: string | null = null;

  let refs = 0;
  let storeIdentityEpoch = identityEpoch;
  let generation = 0;
  let fetching = false;
  let fetchQueued = false;
  let started = false;
  let disposeOps: (() => void) | null = null;
  let queryHash: string | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    snap = null;
    for (const fn of listeners) fn();
  };
  const unlist = (id: string) => {
    const before = items.length + optimistic.length;
    items = items.filter((i) => i.id !== id);
    optimistic = optimistic.filter((o) => o.id !== id && o.tmp !== id);
    if (items.length + optimistic.length === before) return;
    holdItems();
    notify();
  };
  const holder = { republish: notify, unlist };
  /** The store's list in storage, known once a background read has built its chain. */
  let storeList: { key: string; type: string } | null = null;

  /** Its rows, its optimistic rows and waiting creates, less every row a waiting delete names. */
  const merged = (): T[] => {
    const removes = waitingRemoves();
    const creates = storeList
      ? (waitingCreates(storeList.key, (data) => hydrate(bindChain(chainFactory()), data)) as T[])
      : [];
    if (optimistic.length === 0 && creates.length === 0 && removes.size === 0) return items;
    const ids = new Set(items.map((i) => i.id).filter(Boolean));
    const tmps = new Set(items.map((i) => i.tmp).filter(Boolean));
    const removed = (row: T) =>
      [row.id, row.tmp].some((id) => id && removes.has(`${storeList?.type}:${id}`));
    return [
      ...items,
      ...[...optimistic, ...creates].filter(
        (o) => !(o.id && ids.has(o.id)) && !(o.tmp && tmps.has(o.tmp)),
      ),
    ].filter((row) => !removed(row));
  };

  /** `holder` lists the store's items, with the page's waiting patches laid over them. */
  const holdItems = () => {
    hold(holder, items, fields);
    layOver(items);
  };

  /** Server rows arrived — drop optimistic entries the server now owns. */
  const drainOptimistic = () => {
    if (optimistic.length === 0) return;
    const ids = new Set(items.map((i) => i.id).filter(Boolean));
    const tmps = new Set(items.map((i) => i.tmp).filter(Boolean));
    optimistic = optimistic.filter(
      (o) => !(o.id && ids.has(o.id)) && !(o.tmp && tmps.has(o.tmp)),
    );
  };

  const reconcile = (next: T[], rows: readonly ServerRow[]): T[] => {
    const byId = new Map(
      items.filter((item) => item.id).map((item) => [item.id, item]),
    );
    const optimisticById = new Map(
      optimistic.filter((item) => item.id).map((item) => [item.id, item]),
    );
    const optimisticByTmp = new Map(
      optimistic.filter((item) => item.tmp).map((item) => [item.tmp, item]),
    );
    let membershipChanged = items.length !== next.length;
    const result = next.map((fresh, index) => {
      const existing =
        (fresh.id &&
          (recordFor(fresh, fields) ?? byId.get(fresh.id) ?? optimisticById.get(fresh.id))) ||
        (fresh.tmp && optimisticByTmp.get(fresh.tmp));
      if (!existing) {
        membershipChanged = true;
        return fresh;
      }

      mergeRow(existing, fresh, rows[index]!, fields, holder);
      if (items[index] !== existing) membershipChanged = true;
      return existing;
    });

    return membershipChanged ? result : items;
  };

  const hydrate = (
    chain: QueryChain<T>,
    data: Record<string, unknown>,
  ): T | null => {
    const ModelClass = chain.__modelClass as HydratingClass<T> | undefined;
    if (!ModelClass || typeof ModelClass.hydrate !== "function") return null;
    const client = requireClient();
    const adapter =
      client.adapter ??
      chain.__adapter ??
      (Model.hasAdapter() ? Model.getAdapter() : null);
    const BoundModel =
      client.adapter && typeof client.bind === "function"
        ? client.bind(ModelClass as unknown as typeof Model)
        : ModelClass;
    return (BoundModel as unknown as HydratingClass<T>).hydrate(adapter, data);
  };

  const releaseSubscription = () => {
    disposeOps?.();
    disposeOps = null;
    queryHash = null;
  };

  const bindChain = (chain: QueryChain<T>): QueryChain<T> => {
    const client = requireClient();
    const ModelClass = chain.__modelClass as typeof Model | undefined;
    if (!client.adapter || !ModelClass || typeof client.bind !== "function") {
      return chain;
    }
    const BoundModel = client.bind(ModelClass);
    if (chain.__adapter === client.adapter && ModelClass === BoundModel)
      return chain;
    let rebound = client.adapter.query(BoundModel) as unknown as QueryChain<T>;
    for (const step of chain.__steps ?? []) {
      const method = (rebound as any)[step.method];
      if (typeof method === "function") {
        rebound = method(...step.args) as QueryChain<T>;
      }
    }
    return rebound;
  };

  const applyOps = (chain: QueryChain<T>, ops: QueryOp[], order?: string[]) => {
    "background only";
    let changed = false;
    const added: ServerRow[] = [];

    for (const op of ops) {
      if (op.op === "remove") {
        const before = items.length + optimistic.length;
        items = items.filter((i) => i.id !== op.id);
        optimistic = optimistic.filter(
          (o) => o.id !== op.id && o.tmp !== op.id,
        );
        if (items.length + optimistic.length !== before) changed = true;
      } else if (op.op === "add" && op.data) {
        if (items.some((i) => i.id === op.id)) continue;
        // A row we created optimistically echoes back — merge into the
        // existing instance so references stay stable. Models
        // self-assign ids at construction and `save()` adopts the
        // server-minted id, so the id match is the primary path (tmp
        // is belt-and-braces).
        const tmp = op.data.tmp as string | undefined;
        const local = optimistic.find(
          (o) => o.id === op.id || (tmp && o.tmp === tmp),
        );
        const row = hydrate(chain, op.data);
        if (!row) continue;
        const existing = recordFor(row, fields) ?? local;
        if (existing) mergeRow(existing, row, op.data, fields, holder);
        items = [...items, existing ?? row];
        added.push(op.data);
        changed = true;
      } else if (op.op === "update") {
        items = items.map((row) => {
          if (row.id !== op.id) return row;
          changed = true;
          const apply = row[SYM_SERVER_PATCH];
          if (!apply) return patched(row, op.patch);
          apply.call(row, op.patch);
          return row;
        });
      }
    }

    if (order && items.length > 1) {
      const byId = new Map(items.map((i) => [i.id, i]));
      const next: T[] = [];
      for (const id of order) {
        const row = byId.get(id);
        if (row) {
          next.push(row);
          byId.delete(id);
        }
      }
      for (const rest of byId.values()) next.push(rest);
      items = next;
      changed = true;
    }

    if (changed) {
      answers++;
      drainOptimistic();
      holdItems();
      keepAnswer(chain, added);
      notify();
    }
  };

  const doFetch = () => {
    "background only";
    if (refs === 0 || isSuspended) return;
    if (fetching) {
      fetchQueued = true;
      return;
    }
    fetching = true;
    const fetchGeneration = generation;
    const bound = bindChain(chainFactory());
    const chain = subscribe ? bound : (bound.withSubscribe?.(false) ?? bound);
    storeList ??= listOf(chain);
    const client = requireClient();
    client
      .withQuerySubscriptions(async () => {
        const result = await chain.find();
        if (fetchGeneration !== generation) return;
        // Emitted on the client as "answer" for the app to time.
        client._emitDiagnostic?.("answer", {});
        const rows = (result as unknown as { __rows: ServerRow[] }).__rows;
        fields = fieldsOf(chain.__steps);
        items = reconcile(result, rows);
        answers++;
        status = "ready";
        error = null;
        total = (result as { __totalCount?: number }).__totalCount ?? items.length;
        answered = true;
        drawn = true;
        storedUser = null;
        drainOptimistic();
        holdItems();
        keepAnswer(chain, rows);

        const hash = (result as { __queryHash?: string }).__queryHash;
        if (hash && hash !== queryHash) {
          releaseSubscription();
          queryHash = hash;
          disposeOps = client.subscribe(`query:${hash}`, (
            payload: unknown,
          ) => {
            if (fetchGeneration !== generation) return;
            const p = payload as
              | { ops?: QueryOp[]; order?: string[] }
              | QueryOp[];
            const ops = Array.isArray(p) ? p : (p?.ops ?? []);
            const order = Array.isArray(p) ? undefined : p?.order;
            if (ops.length || order) applyOps(chain, ops, order);
          });
        } else if (!hash && queryHash) {
          releaseSubscription();
        }
        notify();
      })
      .catch((err: Error) => {
        if (fetchGeneration !== generation) return;
        error = err;
        status = answered && items.length ? "ready" : "error";
        notify();
      })
      .finally(() => {
        if (fetchGeneration !== generation) return;
        fetching = false;
        if (fetchQueued) {
          fetchQueued = false;
          doFetch();
        }
      });
  };

  /** Every answer its read keeps is stored: its `rows` and the read's list, as the account read as. */
  const keepAnswer = (chain: QueryChain<T>, rows: readonly ServerRow[]) => {
    const list = listOf(chain);
    if (!readAs || !list || !sharesRecords(fields) || options.keeps?.(items) === false) return;
    const ids = JSON.stringify(items.map((item) => item.id));
    writeRows(readAs, rows, fields, { ...list, ids, total });
  };

  // A stored answer draws only while no server answer has, only for the account the session may
  // settle on, and only if the account hasn't changed since storage was asked.
  const readStored = () => {
    "background only";
    const storage = rowStorage();
    if (!storage || storageRead || answered || items.length) return;
    storageRead = true;
    const epoch = identityEpoch;
    const chain = bindChain(chainFactory());
    const list = listOf(chain);
    storeList ??= list;
    const readFields = fieldsOf(chain.__steps);
    if (!list || !sharesRecords(readFields)) return;
    Promise.all([storage.read({ type: list.type, key: list.key, ids: options.ids ?? [] }), refreshWrites()])
      .then(([{ user, list: kept, rows }]) => {
        if (epoch !== identityEpoch || answered || items.length || !user) return;
        if (!isSuspended && user !== readAs) return;
        const data = new Map(rows.map((row) => [row.id, row.data]));
        const order: string[] = kept ? JSON.parse(kept.ids) : [...(options.ids ?? [])];
        // A kept list draws whole or not at all: one missing a row waits for the server.
        if (kept && !order.every((id) => data.has(id))) return;
        const found = order.flatMap((id) => {
          const stored = data.get(id);
          const saved: ServerRow | null = stored ? JSON.parse(stored) : null;
          const row = saved && hydrate(chain, saved);
          if (!row) return [];
          // Another read's record takes the kept row over the fields this read asks for, as an answer would.
          const existing = recordFor(row, readFields);
          if (existing) mergeRow(existing, row, saved, readFields, holder);
          return [existing ?? row];
        });
        // A kept list is an answer even when empty; ids alone draw only what they find.
        if (!kept && found.length === 0) return;
        items = found;
        fields = readFields;
        total = kept?.total ?? found.length;
        drawn = true;
        storedUser = user;
        holdItems();
        notify();
      })
      .catch((err: Error) => {
        if (answered) return;
        error = err;
        notify();
      });
  };

  const stop = () => {
    generation++;
    fetching = false;
    fetchQueued = false;
    started = false;
    releaseSubscription();
  };

  const invalidateIdentity = () => {
    if (storeIdentityEpoch === identityEpoch) return;
    stop();
    storeIdentityEpoch = identityEpoch;
    if (storedUser !== null && (isSuspended || storedUser === readAs)) {
      holdItems();
      return;
    }
    items = [];
    optimistic = [];
    status = "loading";
    error = null;
    total = 0;
    answered = false;
    drawn = false;
    storageRead = false;
    storedUser = null;
    holdItems();
    notify();
  };

  const internal: StoreInternal = {
    reset(refetchActive) {
      invalidateIdentity();
      // A stored read the reset overtook draws nothing; a retained store reads storage again.
      if (refs > 0) readStored();
      if (refs > 0 && refetchActive) {
        started = true;
        doFetch();
      }
    },
    refetchIfActive() {
      if (refs > 0 && !isSuspended) {
        started = true;
        doFetch();
      }
    },
    holder,
    listKey: () => storeList?.key ?? null,
  };

  const store: LiveQueryStore<T> = {
    snapshot() {
      invalidateIdentity();
      if (!snap) snap = { items: merged(), status, error, total, answers, drawn };
      return snap;
    },
    retain(onChange: () => void) {
      "background only";
      invalidateIdentity();
      listeners.add(onChange);
      refs++;
      registry.add(internal);
      if (refs === 1) {
        refreshWrites().then(sendWrites, (err: Error) => {
          if (answered) return;
          error = err;
          notify();
        });
      }
      readStored();
      if (!started && !isSuspended) {
        started = true;
        doFetch();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        listeners.delete(onChange);
        refs--;
        if (refs === 0) {
          stop();
          registry.delete(internal);
        }
      };
    },
    refetch() {
      "background only";
      if (refs > 0 && !isSuspended) doFetch();
    },
    addOptimistic(item: T) {
      optimistic = [...optimistic, item];
      notify();
    },
    removeOptimistic: unlist,
  };
  internals.set(store, internal);
  return store;
}
