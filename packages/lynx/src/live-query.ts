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

import { Model, SYM_SERVER_MERGE } from "@parcae/model";

import { requireClient } from "./client-registry";

export type LiveStatus = "loading" | "ready" | "error";

export interface LiveSnapshot<T> {
  items: T[];
  status: LiveStatus;
  error: Error | null;
}

export interface QueryChain<T> {
  find(): Promise<T[]>;
  // ModelConstructor's static side is type-erased at the chain
  // boundary; hydrate is cast back on at the single call site.
  __modelClass?: unknown;
  __adapter?: unknown;
}

interface HydratingClass<T> {
  hydrate(adapter: unknown, data: Record<string, unknown>): T;
}

type QueryOp =
  | { op: "add"; id: string; data?: Record<string, unknown> }
  | { op: "remove"; id: string }
  | { op: "update"; id: string };

export interface LiveRow {
  id?: string;
  tmp?: string;
  [SYM_SERVER_MERGE]?: (data: Record<string, unknown>) => unknown;
}

export interface LiveQueryStore<T> {
  snapshot(): LiveSnapshot<T>;
  /** Subscribe + refcount. First retainer triggers the fetch. */
  retain(onChange: () => void): () => void;
  refetch(): void;
  /** Insert a locally-created row until the server echoes it back. */
  addOptimistic(item: T): void;
  removeOptimistic(id: string): void;
}

interface StoreInternal {
  reset(): void;
  refetchIfActive(): void;
}

const registry = new Set<StoreInternal>();

/** Drop all store state (identity changed — rows belong to another user). */
export function resetLiveQueries(): void {
  "background only";
  for (const s of registry) s.reset();
}

/** Re-run every active store's query (reconnect re-established the session). */
export function refetchLiveQueries(): void {
  "background only";
  for (const s of registry) s.refetchIfActive();
}

/** How long update-op refetches coalesce before hitting the server. */
const UPDATE_REFETCH_DELAY = 250;

export function createLiveQuery<T extends LiveRow>(
  chainFactory: () => QueryChain<T>,
): LiveQueryStore<T> {
  let items: T[] = [];
  let optimistic: T[] = [];
  let status: LiveStatus = "loading";
  let error: Error | null = null;
  let snap: LiveSnapshot<T> | null = null;

  let refs = 0;
  let fetching = false;
  let fetchQueued = false;
  let started = false;
  let disposeOps: (() => void) | null = null;
  let updateTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    snap = null;
    for (const fn of listeners) fn();
  };

  const merged = (): T[] => {
    if (optimistic.length === 0) return items;
    const ids = new Set(items.map((i) => i.id).filter(Boolean));
    const tmps = new Set(items.map((i) => i.tmp).filter(Boolean));
    return [
      ...items,
      ...optimistic.filter(
        (o) => !(o.id && ids.has(o.id)) && !(o.tmp && tmps.has(o.tmp)),
      ),
    ];
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

  const hydrate = (
    chain: QueryChain<T>,
    data: Record<string, unknown>,
  ): T | null => {
    const ModelClass = chain.__modelClass as HydratingClass<T> | undefined;
    if (!ModelClass || typeof ModelClass.hydrate !== "function") return null;
    const adapter =
      chain.__adapter ?? (Model.hasAdapter() ? Model.getAdapter() : null);
    return ModelClass.hydrate(adapter, data);
  };

  const applyOps = (chain: QueryChain<T>, ops: QueryOp[], order?: string[]) => {
    "background only";
    let changed = false;
    let needsRefetch = false;

    for (const op of ops) {
      if (op.op === "remove") {
        const before = items.length + optimistic.length;
        items = items.filter((i) => i.id !== op.id);
        optimistic = optimistic.filter((o) => o.id !== op.id && o.tmp !== op.id);
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
        const mergeFn = local?.[SYM_SERVER_MERGE];
        if (local && typeof mergeFn === "function") {
          items = [...items, mergeFn.call(local, op.data) as T];
        } else {
          const row = hydrate(chain, op.data);
          if (row) items = [...items, row];
        }
        changed = true;
      } else if (op.op === "update") {
        // Field patches ride on fast-json-patch in the SDK; a refetch
        // keeps that dependency (and its regexes) away from Lynx's
        // main-thread bytecode compiler. Update frames are rare on
        // membership-style lists.
        needsRefetch = true;
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
      drainOptimistic();
      notify();
    }
    if (needsRefetch && !updateTimer) {
      updateTimer = setTimeout(() => {
        updateTimer = null;
        doFetch();
      }, UPDATE_REFETCH_DELAY);
    }
  };

  const doFetch = () => {
    "background only";
    if (fetching) {
      fetchQueued = true;
      return;
    }
    fetching = true;
    const chain = chainFactory();
    chain
      .find()
      .then((result) => {
        items = result;
        status = "ready";
        error = null;
        drainOptimistic();

        const hash = (result as { __queryHash?: string }).__queryHash;
        if (hash) {
          disposeOps?.();
          disposeOps = requireClient().subscribe(
            `query:${hash}`,
            (payload: unknown) => {
              const p = payload as
                | { ops?: QueryOp[]; order?: string[] }
                | QueryOp[];
              const ops = Array.isArray(p) ? p : (p?.ops ?? []);
              const order = Array.isArray(p) ? undefined : p?.order;
              if (ops.length || order) applyOps(chain, ops, order);
            },
          );
        }
        notify();
      })
      .catch((err: Error) => {
        error = err;
        status = items.length ? "ready" : "error";
        notify();
      })
      .finally(() => {
        fetching = false;
        if (fetchQueued) {
          fetchQueued = false;
          doFetch();
        }
      });
  };

  const internal: StoreInternal = {
    reset() {
      disposeOps?.();
      disposeOps = null;
      items = [];
      optimistic = [];
      status = "loading";
      error = null;
      started = false;
      notify();
      if (refs > 0) {
        started = true;
        doFetch();
      }
    },
    refetchIfActive() {
      if (refs > 0) doFetch();
    },
  };
  registry.add(internal);

  return {
    snapshot() {
      if (!snap) snap = { items: merged(), status, error };
      return snap;
    },
    retain(onChange: () => void) {
      "background only";
      listeners.add(onChange);
      refs++;
      if (!started) {
        started = true;
        doFetch();
      }
      return () => {
        listeners.delete(onChange);
        refs--;
      };
    },
    refetch() {
      "background only";
      doFetch();
    },
    addOptimistic(item: T) {
      optimistic = [...optimistic, item];
      notify();
    },
    removeOptimistic(id: string) {
      const before = items.length + optimistic.length;
      items = items.filter((i) => i.id !== id);
      optimistic = optimistic.filter((o) => o.id !== id && o.tmp !== id);
      if (items.length + optimistic.length !== before) notify();
    },
  };
}
