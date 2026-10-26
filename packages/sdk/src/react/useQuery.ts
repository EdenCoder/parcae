"use client";

import {
  generateId,
  Model,
  patched,
  rowVersion,
  SESSION_BOUNDARY_ERRORS,
  serializeLazyQueryArgs,
  SYM_SERVER_MERGE,
  SYM_SERVER_PATCH,
  SYM_VERSION,
  type PatchOp,
} from "@parcae/model";
import { computed, effect, signal, type ReadonlySignal, type Signal } from "@preact/signals-core";
import { useEffect, useMemo, useRef } from "react";
import type { ParcaeClient } from "../client";
import { log } from "../log";
import { useParcae } from "./context";
import { useSession } from "./useSession";
import { revision } from "../signals";
import { useSignalValue } from "./useSignalValue";

interface QueryChain<T> {
  find(): Promise<T[]>;
  __steps?: any[];
  __modelType?: string;
  __modelClass?: any;
  __adapter?: any;
  /** Returns a sibling chain whose `.find()` sends `__forceRefresh: true`. */
  withForceRefresh?: () => QueryChain<T>;
  /** Returns a sibling chain whose `.find()` sends `__subscribe: false`. */
  withSubscribe?: (subscribe: boolean) => QueryChain<T>;
}

interface UseQueryOptions {
  /**
   * Drift-detection refetch interval, in ms. Pauses while the tab is
   * hidden or the transport is disconnected. Default 0, which never
   * polls.
   */
  poll?: number;
  /**
   * When `false`, the query is treated as static: no server-side
   * `QuerySubscriptionManager` registration, no `client.subscribe`
   * listener for `query:${hash}` ops. The find request carries
   * `__subscribe: false` and the response omits `__queryHash`. On
   * reconnect, static entries are re-fetched (no subscription
   * registered server-side). Orthogonal to `poll` — set both for a
   * poll-driven refresh without realtime push. Default `true`.
   */
  subscribe?: boolean;
}

/** What a query holds; a new state replaces it whenever any part moves, a row's fields included. */
export interface QueryState<T = any> {
  items: T[];
  loading: boolean;
  error: Error | null;
  /** Total matching records on the server (before limit/offset). */
  total: number;
  version: number;
}

interface QueryActions<T> {
  refetch: () => void;
  addOptimistic: (item: T | Record<string, any>) => T;
  removeOptimistic: (item: T | string) => void;
  onOps: (listener: (ops: QueryOp[]) => void) => () => void;
}

/** A live query as signals, shared by every reader of its cache entry. */
export interface Live<T> extends QueryActions<T> {
  readonly state: ReadonlySignal<QueryState<T>>;
  readonly items: ReadonlySignal<T[]>;
  readonly loading: ReadonlySignal<boolean>;
  /** Moves once per tick in which any row's fields moved, local writes included. */
  readonly version: ReadonlySignal<number>;
}

type UseQueryResult<T> = Omit<QueryState<T>, "version"> & QueryActions<T>;

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  key: string;
  items: any[];
  optimistic: any[];
  mergedItems: any[];
  mergedKey: string;
  loading: boolean;
  error: Error | null;
  state: Signal<QueryState>;
  live: Live<any> | null;
  version: number;
  refs: number;
  dispose: (() => void) | null;
  gcTimer: ReturnType<typeof setTimeout> | null;
  queryHash: string | null;
  totalCount: number;
  chain: QueryChain<any> | null;
  client: ParcaeClient;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /**
   * A fetch or resync has successfully answered this entry at least
   * once. Zero rows is an answer, so `items.length` cannot stand in for
   * this: `reconcile` returns the previous array when neither length
   * changed, which leaves a legitimately-empty result pointing at the
   * shared `EMPTY` sentinel and indistinguishable from never-fetched.
   */
  loaded: boolean;
  fetchPromise: Promise<void> | null;
  /**
   * A batched `resync` covering this entry is in flight. Set alongside
   * the generation bump in `_onResyncRequired`, which supersedes any
   * running `doFetch` — so between those two points the resync is the
   * only thing that can settle the entry, and the mount effect must not
   * race a second fetch against it.
   */
  resyncPending: boolean;
  generation: number;
  pollConsumers: Map<symbol, number>;
  pollTimer: ReturnType<typeof setTimeout> | null;
  isPollInitial: boolean;
  opsListeners: Set<(ops: QueryOp[]) => void>;
  /**
   * `false` when this entry was created from a `{ subscribe: false }`
   * call site. Captured at entry creation (and baked into the cache
   * key, so static and dynamic mounts of the same chain don't share
   * an entry). `doFetch` injects `__subscribe: false` on the wire and
   * `_onResyncRequired` skips re-registering a subscription.
   */
  subscribe: boolean;
}

let caches = new WeakMap<ParcaeClient, Map<string, CacheEntry>>();
const GC_DELAY = 60_000;
const QUERY_STUCK_MS = 10_000;
const EMPTY: any[] = [];
const INITIAL_STATE: QueryState = { items: EMPTY, loading: true, error: null, total: 0, version: 0 };

/**
 * Drop this client's entries for the identity that just ended.
 */
function getCache(client: ParcaeClient): Map<string, CacheEntry> {
  let cache = caches.get(client);
  if (!cache) {
    cache = new Map();
    caches.set(client, cache);
    const handleDispose = () => {
      const entries = [...cache!.values()];
      cache!.clear();
      caches.delete(client);
      client.off("dispose", handleDispose);
      for (const entry of entries) {
        disposeEntry(entry, new Error("Query client disposed"));
      }
    };
    client.on("dispose", handleDispose);
  }
  return cache;
}

function disposeEntry(entry: CacheEntry, error?: Error): void {
  entry.generation++;
  detachSubscription(entry);
  if (entry.gcTimer) clearTimeout(entry.gcTimer);
  if (entry.retryTimer) clearTimeout(entry.retryTimer);
  if (entry.pollTimer) clearTimeout(entry.pollTimer);
  entry.gcTimer = null;
  entry.retryTimer = null;
  entry.pollTimer = null;
  entry.fetchPromise = null;
  if (error) {
    entry.error = error;
    entry.loading = false;
    notify(entry);
  }
}

// ── Identity handoff ────────────────────────────────────────────────
//
// On sign-in (anonymous → authenticated) every cache key re-keys
// because the userId is baked into it. Purging the old entries
// outright sends every mounted `useQuery` back to `loading: true`
// with empty items — the whole UI flashes skeletons. The anonymous
// data is public, though, so the old entries are retired into a
// short-lived pool keyed WITHOUT the identity segment; a fresh entry
// created for the same model+steps seeds itself from the pool and
// refetches in the background (stale-while-revalidate).
//
// Only the anonymous → authenticated direction is pooled: scoped
// data must never seed another identity's view, so sign-out and
// account switches still dispose + refetch from scratch.

interface StaleEntry {
  entry: CacheEntry;
  timer: ReturnType<typeof setTimeout>;
}

let stalePools = new WeakMap<ParcaeClient, Map<string, StaleEntry>>();
const STALE_TTL = 30_000;

/**
 * Cache key minus its identity segment — `model:user:steps` becomes
 * `model:*:steps`. Model types never contain `:`; the steps JSON sits
 * after the second colon and is preserved verbatim (including the
 * `:nosub` suffix), so static and dynamic variants never cross-seed.
 */
function stripIdentity(key: string): string {
  const first = key.indexOf(":");
  const second = key.indexOf(":", first + 1);
  if (first < 0 || second < 0) return key;
  return `${key.slice(0, first)}:*${key.slice(second)}`;
}

function retireToStalePool(client: ParcaeClient, entry: CacheEntry): void {
  let pool = stalePools.get(client);
  if (!pool) {
    pool = new Map();
    stalePools.set(client, pool);
  }
  // Detach live resources but keep the data for seeding.
  entry.generation++;
  detachSubscription(entry);
  if (entry.gcTimer) clearTimeout(entry.gcTimer);
  if (entry.retryTimer) clearTimeout(entry.retryTimer);
  if (entry.pollTimer) clearTimeout(entry.pollTimer);
  entry.gcTimer = null;
  entry.retryTimer = null;
  entry.pollTimer = null;
  entry.fetchPromise = null;

  const poolKey = stripIdentity(entry.key);
  const existing = pool.get(poolKey);
  if (existing) {
    clearTimeout(existing.timer);
    disposeEntry(existing.entry);
  }
  const timer = setTimeout(() => {
    if (pool.get(poolKey)?.entry === entry) pool.delete(poolKey);
    disposeEntry(entry);
  }, STALE_TTL);
  pool.set(poolKey, { entry, timer });
}

function takeStaleSeed(client: ParcaeClient, key: string): CacheEntry | null {
  const pool = stalePools.get(client);
  if (!pool) return null;
  const poolKey = stripIdentity(key);
  const stale = pool.get(poolKey);
  if (!stale) return null;
  pool.delete(poolKey);
  clearTimeout(stale.timer);
  disposeEntry(stale.entry);
  return stale.entry;
}

function purgeCacheForUser(
  client: ParcaeClient,
  prevUserId: string | null,
  nextUserId?: string | null,
): void {
  const cache = caches.get(client);
  if (!cache) return;
  const needle = `:${prevUserId ?? "anon"}:`;
  const poolable = prevUserId === null && nextUserId != null;
  for (const [key, entry] of cache) {
    if (!key.includes(needle)) continue;
    cache.delete(key);
    if (poolable) retireToStalePool(client, entry);
    else disposeEntry(entry, new Error("Query identity changed"));
  }
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1_000, 3_000, 10_000];

export function getMergedItems(entry: CacheEntry): any[] {
  if (entry.optimistic.length === 0) {
    if (entry.mergedItems !== entry.items) {
      entry.mergedItems = entry.items;
      entry.mergedKey = `${entry.version}:0`;
    }
    return entry.items;
  }
  const key = `${entry.version}:${entry.optimistic.length}`;
  if (entry.mergedKey === key) return entry.mergedItems;

  const seenIds = new Set<string>();
  const seenTmps = new Set<string>();
  const merged: any[] = [];
  for (const item of entry.items) {
    if (item?.id) seenIds.add(item.id);
    if (item?.tmp) seenTmps.add(item.tmp);
    merged.push(item);
  }
  for (const item of entry.optimistic) {
    if (item?.id && seenIds.has(item.id)) continue;
    if (item?.tmp && seenTmps.has(item.tmp)) continue;
    merged.push(item);
  }
  entry.mergedItems = merged;
  entry.mergedKey = key;
  return merged;
}

function getOrCreate(
  client: ParcaeClient,
  key: string,
  subscribe?: boolean,
): CacheEntry {
  const cache = getCache(client);
  let e = cache.get(key);
  if (!e) {
    // Derive from the key suffix when not passed explicitly. Lets
    // `addOptimistic` / `refetch` / `__test.fetch` callers stay
    // ignorant of the subscribe contract — the key already encodes
    // it (see `buildKey`'s `:nosub` suffix). Prevents a GC'd entry
    // from being re-created with the wrong mode.
    const resolved = subscribe ?? !key.endsWith(":nosub");
    e = {
      key,
      items: EMPTY,
      optimistic: [],
      mergedItems: EMPTY,
      mergedKey: "0:0",
      loading: true,
      error: null,
      state: signal(INITIAL_STATE),
      live: null,
      version: 0,
      refs: 0,
      dispose: null,
      gcTimer: null,
      queryHash: null,
      totalCount: 0,
      chain: null,
      client,
      retryCount: 0,
      loaded: false,
      retryTimer: null,
      fetchPromise: null,
      resyncPending: false,
      generation: 0,
      pollConsumers: new Map(),
      pollTimer: null,
      isPollInitial: true,
      opsListeners: new Set(),
      subscribe: resolved,
    };
    // Seed from the identity handoff pool (anonymous → authenticated
    // sign-in): keep rendering the previous public data while the
    // mount effect refetches against the new identity, instead of
    // flashing every list back to skeletons.
    const stale = takeStaleSeed(client, key);
    if (stale && stale.items.length > 0) {
      e.items = stale.items;
      e.mergedItems = stale.items;
      e.totalCount = stale.totalCount;
      e.loaded = true;
      e.loading = false;
      e.version = stale.version;
      notify(e);
    }
    cache.set(key, e);
  }
  return e;
}

function notify(e: CacheEntry): void {
  const now = e.state.peek();
  const items = getMergedItems(e);
  if (
    now.items === items &&
    now.loading === e.loading &&
    now.error === e.error &&
    now.total === e.totalCount &&
    now.version === e.version
  )
    return;
  e.state.value = {
    items,
    loading: e.loading,
    error: e.error,
    total: e.totalCount,
    version: e.version,
  };
}

/** Collect an entry nothing holds once the grace period passes. */
function collectLater(e: CacheEntry): void {
  if (e.gcTimer || e.refs > 0 || !isLive(e)) return;
  e.gcTimer = setTimeout(() => {
    e.gcTimer = null;
    if (e.refs > 0 || !isLive(e)) return;
    caches.get(e.client)?.delete(e.key);
    disposeEntry(e);
  }, GC_DELAY);
}

function release(e: CacheEntry): void {
  e.refs--;
  if (e.refs > 0) return;
  if (e.retryTimer) {
    clearTimeout(e.retryTimer);
    e.retryTimer = null;
  }
  collectLater(e);
}

function hold(e: CacheEntry): void {
  e.refs++;
  if (e.gcTimer) {
    clearTimeout(e.gcTimer);
    e.gcTimer = null;
  }
}

function detachSubscription(entry: CacheEntry): void {
  const hash = entry.queryHash;
  entry.dispose?.();
  entry.dispose = null;
  entry.queryHash = null;
  if (hash && typeof entry.client.send === "function") {
    entry.client.send("unsubscribe:query", hash);
  }
}

// ── Ops application ─────────────────────────────────────────────────────────

type QueryOp =
  | { op: "add"; id: string; data: Record<string, any> }
  | { op: "remove"; id: string }
  | { op: "update"; id: string; patch: PatchOp[] };

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

interface QueryEnvelope {
  ops: QueryOp[];
  order?: string[];
}

interface ApplyResult {
  items: any[];
  changed: boolean;
}

function normalizeOpsPayload(
  raw: unknown,
): { ops: QueryOp[]; order?: string[] } | null {
  if (Array.isArray(raw)) return { ops: raw as QueryOp[] };
  if (raw && typeof raw === "object" && Array.isArray((raw as any).ops)) {
    const envelope = raw as QueryEnvelope;
    return envelope.order
      ? { ops: envelope.ops, order: envelope.order }
      : { ops: envelope.ops };
  }
  return null;
}

function reorderByIds<T extends { id: string }>(
  items: T[],
  order: string[],
): T[] | null {
  if (items.length === 0) return null;
  if (items.length === order.length) {
    let same = true;
    for (let i = 0; i < items.length; i++) {
      if (items[i]?.id !== order[i]) {
        same = false;
        break;
      }
    }
    if (same) return null;
  }
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  const next: T[] = [];
  for (const id of order) {
    const found = byId.get(id);
    if (found) next.push(found);
  }
  if (next.length !== items.length) {
    const placed = new Set(order);
    for (const item of items) {
      if (!placed.has(item.id)) next.push(item);
    }
  }
  return next;
}

function applyOps(
  items: any[],
  ops: QueryOp[],
  modelClass: any,
  adapter: any,
  entry?: CacheEntry,
): ApplyResult {
  if (ops.length === 0) return { items, changed: false };

  const addOps = new Map<string, Record<string, any>>();
  const updateOps = new Map<string, PatchOp[]>();
  const removeIds = new Set<string>();

  for (const op of ops) {
    switch (op.op) {
      case "add":
        if (op.data) addOps.set(op.id, op.data);
        break;
      case "update":
        if (op.patch) {
          const existing = updateOps.get(op.id);
          if (existing) existing.push(...op.patch);
          else updateOps.set(op.id, [...op.patch]);
        }
        break;
      case "remove":
        removeIds.add(op.id);
        break;
    }
  }

  const byId = new Map<string, any>();
  for (const item of items) byId.set(item.id, item);

  const optimisticByTmp = new Map<string, any>();
  if (entry?.optimistic) {
    for (const item of entry.optimistic) {
      if (item.tmp) optimisticByTmp.set(item.tmp, item);
    }
  }

  const hasRemoves = removeIds.size > 0;
  const hasAdds = addOps.size > 0;

  let didUpdate = false;
  for (const [id, patches] of updateOps) {
    let existing = byId.get(id);
    if (!existing && entry?.optimistic) {
      existing = entry.optimistic.find((o: any) => o.id === id);
    }
    if (!existing) continue;

    const pendingPaths: ReadonlySet<string> | undefined = existing.__patchingPaths;
    const filtered = pendingPaths?.size
      ? patches.filter((patch) => {
          for (const pendingPath of pendingPaths) {
            if (pathsOverlap(patch.path, pendingPath)) return false;
          }
          return true;
        })
      : patches;

    if (filtered.length === 0) continue;

    if (typeof existing[SYM_SERVER_PATCH] === "function") {
      existing[SYM_SERVER_PATCH](filtered);
    } else {
      for (const [k, v] of Object.entries(patched(existing.__data ?? {}, filtered))) {
        existing[k] = v;
      }
    }
    didUpdate = true;
  }

  if (!hasRemoves && !hasAdds && !didUpdate) {
    return { items, changed: false };
  }

  if (!hasRemoves && !hasAdds) {
    // Update-only frame. The models in the array merged the patch in
    // place, so the array keeps its identity and field readers wake
    // through each row's own signals (`field` / `useModelAtomic`).
    //
    // `changed: true` still bumps `entry.version`, which replaces the
    // entry's state, so every `useQuery` caller of this entry renders
    // again. That's deliberate: consumers rendering row fields straight
    // off `items` (`items.map(i => i.title)`) stay live without a field
    // read. The cost is one container render per server re-eval window,
    // bounded by the backend's debounce and `Model.realtime` overrides.
    return { items, changed: true };
  }

  const result: any[] = [];

  for (const item of items) {
    if (removeIds.has(item.id)) continue;
    result.push(item);
  }

  for (const [id, data] of addOps) {
    if (byId.has(id)) continue;

    const serverTmp = data.tmp;
    const optimistic =
      entry?.optimistic.find((item: any) => item.id === id) ??
      (serverTmp ? optimisticByTmp.get(serverTmp) : null);

    if (optimistic) {
      if (typeof optimistic[SYM_SERVER_MERGE] === "function") {
        result.push(optimistic[SYM_SERVER_MERGE](data));
      } else {
        result.push(modelClass.hydrate(adapter, data));
      }
      optimisticByTmp.delete(serverTmp);
    } else {
      result.push(modelClass.hydrate(adapter, data));
    }
  }

  if (entry?.optimistic.length) {
    drainOptimistic(result, entry);
    if (removeIds.size > 0) {
      entry.optimistic = entry.optimistic.filter(
        (o: any) => !removeIds.has(o.id) && (!o.tmp || !removeIds.has(o.tmp)),
      );
    }
  }

  return { items: result, changed: true };
}

function reconcile(
  prev: any[],
  next: any[],
  entry?: CacheEntry,
): ApplyResult {
  const prevById = new Map<string, any>();
  for (const item of prev) prevById.set(item.id, item);
  const optimisticById = new Map<string, any>();
  const optimisticByTmp = new Map<string, any>();
  for (const item of entry?.optimistic ?? []) {
    if (item.id) optimisticById.set(item.id, item);
    if (item.tmp) optimisticByTmp.set(item.tmp, item);
  }

  let membershipChanged = prev.length !== next.length;
  let scalarChanged = false;
  const result: any[] = new Array(next.length);

  for (let i = 0; i < next.length; i++) {
    const fresh = next[i];
    const existing =
      prevById.get(fresh.id) ??
      optimisticById.get(fresh.id) ??
      (fresh.tmp ? optimisticByTmp.get(fresh.tmp) : undefined);
    if (existing) {
      // A held row a resync did not resend is already current.
      if (existing !== fresh && typeof existing[SYM_SERVER_MERGE] === "function") {
        const previousVersion = existing[SYM_VERSION];
        existing[SYM_SERVER_MERGE](fresh);
        if (existing[SYM_VERSION] !== previousVersion) scalarChanged = true;
      }
      result[i] = existing;
      if (!membershipChanged && prev[i]?.id !== fresh.id) {
        membershipChanged = true;
      }
    } else {
      result[i] = fresh;
      membershipChanged = true;
    }
  }

  if (entry?.optimistic.length) {
    const optimisticCount = entry.optimistic.length;
    drainOptimistic(result, entry);
    if (entry.optimistic.length !== optimisticCount) scalarChanged = true;
  }

  if (!membershipChanged && prev.length === next.length) {
    return { items: prev, changed: scalarChanged };
  }
  return { items: result, changed: true };
}

function drainOptimistic(serverItems: any[], entry: CacheEntry): void {
  if (entry.optimistic.length === 0) return;

  const serverIds = new Set<string>();
  const serverTmps = new Set<string>();
  for (const item of serverItems) {
    if (item.id) serverIds.add(item.id);
    if (item.tmp) serverTmps.add(item.tmp);
  }

  entry.optimistic = entry.optimistic.filter(
    (o: any) => !serverIds.has(o.id) && (!o.tmp || !serverTmps.has(o.tmp)),
  );
}

function bindChainToClient(
  chain: QueryChain<any>,
  client: ParcaeClient,
): QueryChain<any> {
  if (!client.adapter || !chain.__modelClass) return chain;
  const ModelClass = chain.__modelClass as typeof Model;
  const BoundModel =
    typeof client.bind === "function"
      ? client.bind(ModelClass)
      : ModelClass.bind(client.adapter);
  if (chain.__adapter === client.adapter && ModelClass === BoundModel) return chain;
  let rebound: any = client.adapter.query(BoundModel);
  for (const step of chain.__steps ?? []) {
    if (typeof rebound[step.method] !== "function") continue;
    rebound = rebound[step.method](...(step.args ?? []));
  }
  return rebound as QueryChain<any>;
}

// ── Fetch + subscribe ───────────────────────────────────────────────────────

function isLive(entry: CacheEntry): boolean {
  return caches.get(entry.client)?.get(entry.key) === entry;
}

function handleOpsPayload(
  entry: CacheEntry,
  chain: QueryChain<any>,
  adapter: any,
  payload: unknown,
): void {
  if (!isLive(entry)) return;
  const parsed = normalizeOpsPayload(payload);
  if (!parsed) return;
  const { ops, order } = parsed;
  if (ops.length === 0 && !order) return;
  const applied = applyOps(
    entry.items,
    ops,
    chain.__modelClass,
    adapter,
    entry,
  );
  let items = applied.items;
  let changed = applied.changed;
  if (order) {
    const reordered = reorderByIds(items, order);
    if (reordered) {
      items = reordered;
      changed = true;
    }
  }
  if (!changed) return;
  entry.items = items;
  entry.version++;
  notify(entry);
  for (const listener of entry.opsListeners) {
    try {
      listener(ops);
    } catch {}
  }
}

function attachSubscription(
  entry: CacheEntry,
  hash: string,
  chain: QueryChain<any>,
): void {
  if (hash === entry.queryHash || entry.subscribe === false) return;
  detachSubscription(entry);
  entry.queryHash = hash;
  const adapter = entry.client.adapter;
  entry.dispose = entry.client.subscribe(`query:${hash}`, (payload: unknown) => {
    handleOpsPayload(entry, chain, adapter, payload);
  });
}

/**
 * Give up on retrying, and say so in the entry. A caller that leaves
 * `loading` true here strands the entry: nothing is in flight, nothing
 * is scheduled, and every consumer renders a skeleton that no code path
 * will ever resolve. `recoverResyncEntry` pins `loading` true on an
 * authorization boundary and then lands right here whenever the last
 * subscriber has already unmounted.
 */
function abandonRetry(entry: CacheEntry): void {
  if (!entry.loading) return;
  entry.loading = false;
  notify(entry);
}

function scheduleRetry(key: string, entry: CacheEntry): void {
  // A timer already armed IS the scheduled work — leave `loading` alone.
  if (entry.retryTimer) return;
  if (entry.retryCount >= MAX_RETRIES) return abandonRetry(entry);
  if (!entry.chain) return abandonRetry(entry);
  if (entry.refs <= 0) return abandonRetry(entry);

  const delay =
    RETRY_DELAYS[Math.min(entry.retryCount, RETRY_DELAYS.length - 1)]!;
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    if (entry.refs <= 0 || !entry.chain || !isLive(entry)) return;
    entry.retryCount++;
    doFetch(key, entry, entry.chain, entry.client);
  }, delay);
}

/**
 * A resync the server refused because the session that computed it is
 * no longer the socket's session. Rows on screen may predate the
 * current authorization. The strings are the shared wire contract in
 * `SESSION_BOUNDARY_ERRORS`; never match on ad-hoc literals here.
 */
function isAuthorizationBoundaryError(error: Error): boolean {
  return (
    error.message.includes(SESSION_BOUNDARY_ERRORS.notReconciled) ||
    error.message.includes(SESSION_BOUNDARY_ERRORS.terminated)
  );
}

/**
 * A resync outraced by a newer hello on the same socket. Identity
 * changes purge the cache through the session listener, so by the time
 * this fires the entry either belongs to the still-current user or is
 * already disposed — blanking it flashed clinical lists to skeletons
 * on every pure token rotation. Keep the rows and refetch immediately
 * so a same-user authorization downgrade is corrected within one round
 * trip rather than rendered indefinitely.
 */
function isSupersededResyncError(error: Error): boolean {
  return error.message.includes(SESSION_BOUNDARY_ERRORS.changed);
}

function recoverResyncEntry(
  cacheKey: string,
  entry: CacheEntry,
  error: Error,
): void {
  detachSubscription(entry);
  if (isAuthorizationBoundaryError(error)) {
    // Fail closed: rows fetched under the prior authorization must not
    // stay rendered while the retry refetches under the new one.
    if (entry.items.length > 0) {
      entry.items = [];
      entry.version++;
    }
    entry.loaded = false;
    entry.loading = true;
  }
  // Otherwise stale-while-revalidate: keep the last good items on
  // screen while the retry refetches and reconciles. Blanking the
  // entry on a reconnect hiccup flashed every list back to skeletons.
  entry.error = error;
  notify(entry);
  entry.retryCount = 0;
  if (isSupersededResyncError(error) && entry.chain) {
    void doFetch(cacheKey, entry, entry.chain, entry.client, { force: true });
    return;
  }
  scheduleRetry(cacheKey, entry);
}

function doFetch(
  key: string,
  entry: CacheEntry,
  chain: QueryChain<any>,
  client: ParcaeClient,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (entry.client !== client) {
    return Promise.reject(new Error("Query cache client mismatch"));
  }
  if (entry.fetchPromise) return entry.fetchPromise;

  log.debug("useQuery: fetching", chain.__modelType);

  if (!entry.loaded) entry.loading = true;
  entry.error = null;
  // This fetch is now the thing that settles the entry. Any resync
  // claim is superseded by the generation bump below, and its handlers
  // will skip this entry — so the claim must not outlive them.
  entry.resyncPending = false;
  notify(entry);

  const boundChain = bindChainToClient(chain, client);
  entry.chain = boundChain;
  let fetchChain: QueryChain<any> = boundChain;
  if (opts.force && typeof fetchChain.withForceRefresh === "function") {
    fetchChain = fetchChain.withForceRefresh();
  }
  if (
    entry.subscribe === false &&
    typeof fetchChain.withSubscribe === "function"
  ) {
    fetchChain = fetchChain.withSubscribe(false);
  }

  const generation = ++entry.generation;
  let request!: Promise<void>;
  request = (async () => {
    try {
      const result = await fetchChain.find();
      if (!isLive(entry) || entry.generation !== generation) return;
      const hash = (result as any).__queryHash;
      const reconciled = reconcile(entry.items, result, entry);
      entry.items = reconciled.items;
      if (reconciled.changed) entry.version++;
      entry.loaded = true;
      entry.loading = false;
      entry.retryCount = 0;
      if (typeof (result as any).__totalCount === "number") {
        if (entry.totalCount !== (result as any).__totalCount) {
          entry.totalCount = (result as any).__totalCount;
          entry.version++;
        }
      }
      if (entry.retryTimer) {
        clearTimeout(entry.retryTimer);
        entry.retryTimer = null;
      }

      if (hash) attachSubscription(entry, hash, boundChain);

      notify(entry);
    } catch (err) {
      if (!isLive(entry) || entry.generation !== generation) return;
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("useQuery: error", error.message);
      entry.error = error;
      entry.loading = false;
      notify(entry);
      scheduleRetry(key, entry);
    } finally {
      if (entry.fetchPromise === request) entry.fetchPromise = null;
    }
  })();
  entry.fetchPromise = request;
  return request;
}

// ── Resync handler ──────────────────────────────────────────────────────────

/** The rows a loaded entry holds, by id, at the version a resync compares. */
function holdings(entry: CacheEntry): Record<string, string> {
  const refs = [
    ...new Set(
      (entry.chain?.__steps ?? []).flatMap((step: any) =>
        step?.method === "expand"
          ? (step.args ?? []).map((arg: unknown) => String(arg).split(".")[0])
          : []),
    ),
  ].sort();
  return Object.fromEntries(entry.items.map((row: any) => [row.id, rowVersion(row, refs)]));
}

/** The server's order of rows it resent, else held; null when it names a row neither has. */
function heldInOrder(held: any[], fresh: any[], ids: string[]): any[] | null {
  const byId = new Map<string, any>([...held, ...fresh].map((row) => [row.id, row]));
  const next = ids.map((id) => byId.get(id));
  return next.every(Boolean) ? next : null;
}

/**
 * Called by ParcaeProvider after the transport's hello handshake
 * lands on a (re)connection. Fires a batched `resync` RPC for every
 * cache entry that has a live subscription, restoring server-side
 * subscription state in one round trip. Entries with no `queryHash`
 * (never fetched) are handled by the `[key]` mount effect instead.
 */
export function _onResyncRequired(client: ParcaeClient): void {
  const cache = caches.get(client);
  if (!cache) return;
  const entries: {
    cacheKey: string;
    entry: CacheEntry;
    generation: number;
    modelType: string;
    steps: unknown[];
    queryHash: string | null;
    subscribe: boolean;
    have: Record<string, string> | null;
  }[] = [];

  for (const [cacheKey, entry] of cache) {
    if (entry.refs <= 0) continue;
    if (!entry.chain) continue;
    const modelType = entry.chain.__modelType;
    if (!modelType) continue;
    entry.fetchPromise = null;
    entry.resyncPending = true;
    entries.push({
      cacheKey,
      entry,
      generation: ++entry.generation,
      modelType,
      steps: entry.chain.__steps ?? [],
      queryHash: entry.queryHash,
      subscribe: entry.subscribe,
      have: entry.loaded ? holdings(entry) : null,
    });
  }

  if (entries.length === 0) return;

  client
    .resync(
      entries.map((e) => ({
        key: e.cacheKey,
        modelType: e.modelType,
        steps: e.steps,
        queryHash: e.queryHash,
        // Omit `subscribe` when default `true` so older backends that
        // don't know the field continue to work — they treat absence
        // as subscribed, which is the existing behaviour.
        ...(e.subscribe === false ? { subscribe: false } : {}),
        ...(e.have ? { have: e.have } : {}),
      })),
    )
    .then((results) => {
      const byKey = new Map(results.map((r) => [r.key, r]));
      for (const e of entries) {
        const result = byKey.get(e.cacheKey);
        const entry = e.entry;
        if (!isLive(entry) || entry.generation !== e.generation) continue;
        if (
          !result ||
          !Array.isArray(result.items) ||
          typeof result.totalCount !== "number" ||
          (result.hash !== null && typeof result.hash !== "string")
        ) {
          recoverResyncEntry(
            e.cacheKey,
            entry,
            new Error("Incomplete query resync response"),
          );
          continue;
        }

        const items = result.items as any[];
        const adapter = entry.client.adapter;
        const ModelClass = entry.chain?.__modelClass;
        const hydrated = ModelClass
          ? items.map((row) => ModelClass.hydrate(adapter, row))
          : items;
        // An answer to what this entry holds resends only the rows that moved.
        const next = Array.isArray(result.ids)
          ? heldInOrder(entry.items, hydrated, result.ids)
          : hydrated;
        if (!next) {
          recoverResyncEntry(
            e.cacheKey,
            entry,
            new Error("Incomplete query resync response"),
          );
          continue;
        }

        const reconciled = reconcile(entry.items, next, entry);
        entry.items = reconciled.items;
        if (reconciled.changed) entry.version++;
        if (entry.totalCount !== result.totalCount) {
          entry.totalCount = result.totalCount;
          entry.version++;
        }
        entry.loaded = true;
        entry.loading = false;
        entry.error = null;
        entry.retryCount = 0;

        // The server may have rebuilt a fresh subscription on the new
        // socket — wire it up if the hash changed. The old listener
        // is disposed by the swap. Static entries (`subscribe:
        // false`) get `hash: null` back from the resync handler, so
        // this block naturally skips; the explicit `subscribe !==
        // false` guard is defensive in case a misbehaving backend
        // hands one out.
        if (result.hash && entry.chain) {
          attachSubscription(entry, result.hash, entry.chain);
        } else {
          detachSubscription(entry);
        }

        notify(entry);
      }
    })
    .catch((reason: unknown) => {
      const error =
        reason instanceof Error ? reason : new Error(String(reason));
      log.error("useQuery: resync failed:", error.message);
      for (const e of entries) {
        if (!isLive(e.entry) || e.entry.generation !== e.generation) continue;
        recoverResyncEntry(e.cacheKey, e.entry, error);
      }
    })
    .finally(() => {
      // Release every entry this batch claimed, including the ones both
      // handlers skipped on a generation mismatch — a flag left set
      // there would block the mount effect from ever restarting them.
      // A newer batch that already re-claimed an entry owns its flag,
      // which the generation check is what distinguishes.
      for (const e of entries) {
        if (e.entry.generation !== e.generation) continue;
        e.entry.resyncPending = false;
      }
    });
}

// ── useQuery ───────────────────────────────────────────────────────────────

function serializeStepsForKey(steps: any[] | undefined): string {
  // Runs on every render of every `useQuery` consumer. The
  // `serializeLazyQueryArgs` pass is SHALLOW — it only transforms
  // function args (where-callbacks) into their recorded `__nested`
  // step lists and returns everything else by reference — so its
  // per-render cost is one map per step. It must stay: chain
  // factories pre-serialize their `__steps`, but raw steps handed to
  // `buildKey` directly (tests, custom factories) carry live
  // callbacks, and two different predicates must not collapse into
  // one cache key. The real per-render cost here is the
  // `JSON.stringify`, which is the key itself.
  return JSON.stringify(
    (steps ?? []).map((s) => ({
      method: s?.method,
      args: serializeLazyQueryArgs(s?.args ?? []),
    })),
  );
}

/**
 * Build the cache key from a chain + session. Identity-stable across
 * disconnects because session.userId doesn't change on disconnect.
 * `subscribe: false` mounts get a distinct `:nosub` suffix so a
 * static and a dynamic consumer of the same chain don't share the
 * same cache entry (they would otherwise conflict on `queryHash` and
 * the wire shape of the find request).
 */
function buildKey(
  modelType: string | undefined,
  userId: string | null,
  steps: any[] | undefined,
  subscribe = true,
): string | null {
  if (!modelType) return null;
  const subPart = subscribe === false ? ":nosub" : "";
  return `${modelType}:${userId ?? "anon"}:${serializeStepsForKey(steps)}${subPart}`;
}

function schedulePoll(entry: CacheEntry): void {
  if (entry.pollTimer || entry.refs <= 0 || !isLive(entry)) return;
  const intervals = [...entry.pollConsumers.values()].filter((ms) => ms > 0);
  if (intervals.length === 0) return;
  const pollMs = Math.min(...intervals);
  const delay = entry.isPollInitial
    ? pollMs * (0.5 + Math.random())
    : pollMs;

  entry.pollTimer = setTimeout(() => {
    entry.pollTimer = null;
    if (entry.refs <= 0 || !isLive(entry)) return;
    const isVisible =
      typeof document === "undefined" ||
      !document.visibilityState ||
      document.visibilityState === "visible";
    if (isVisible && entry.client.isConnected !== false && entry.chain) {
      void doFetch(entry.key, entry, entry.chain, entry.client, { force: true });
    }
    entry.isPollInitial = false;
    schedulePoll(entry);
  }, delay);
}

function registerPoll(entry: CacheEntry, pollMs: number): () => void {
  const consumer = Symbol();
  const previousInterval = Math.min(...entry.pollConsumers.values(), Infinity);
  if (pollMs > 0) {
    entry.pollConsumers.set(consumer, pollMs);
    if (pollMs < previousInterval && entry.pollTimer) {
      clearTimeout(entry.pollTimer);
      entry.pollTimer = null;
    }
  }
  schedulePoll(entry);
  return () => {
    entry.pollConsumers.delete(consumer);
    if (entry.pollTimer) {
      clearTimeout(entry.pollTimer);
      entry.pollTimer = null;
    }
    schedulePoll(entry);
  };
}

function liveOf(entry: CacheEntry): Live<any> {
  if (entry.live) return entry.live;
  const { state } = entry;
  const items = computed(() => state.value.items);
  // Any row's change, a merge or a local write, and any membership move count once.
  let count = 0;
  const version = computed(() => {
    for (const row of items.value) void revision(row).value;
    return ++count;
  });
  entry.live = {
    state,
    items,
    version,
    loading: computed(() => state.value.loading),
    refetch: () => {
      if (!entry.chain || !isLive(entry)) return;
      entry.retryCount = 0;
      if (entry.retryTimer) {
        clearTimeout(entry.retryTimer);
        entry.retryTimer = null;
      }
      void doFetch(entry.key, entry, entry.chain, entry.client);
    },
    addOptimistic: (item) => {
      const ModelClass = entry.chain?.__modelClass;
      const instance: any =
        item instanceof Model
          ? item
          : ModelClass
            ? entry.client.bind(ModelClass).create(item)
            : item;
      if (!instance.tmp) instance.tmp = generateId();
      entry.optimistic.push(instance);
      entry.version++;
      notify(entry);
      return instance;
    },
    removeOptimistic: (item) => {
      const match =
        typeof item === "string"
          ? (o: any) => o.tmp !== item && o.id !== item
          : (o: any) => o !== item && o.tmp !== (item as any).tmp;
      const before = entry.optimistic.length;
      entry.optimistic = entry.optimistic.filter(match);
      if (entry.optimistic.length === before) return;
      entry.version++;
      notify(entry);
    },
    onOps: (listener) => {
      entry.opsListeners.add(listener);
      return () => {
        entry.opsListeners.delete(listener);
      };
    },
  };
  return entry.live;
}

/** A query no session can run yet: empty, and loading until the session resolves. */
function idleLive(loading: boolean): Live<any> {
  const state = signal<QueryState>({ ...INITIAL_STATE, loading });
  return {
    state,
    items: computed(() => state.value.items),
    loading: computed(() => state.value.loading),
    version: signal(0),
    refetch: () => {},
    addOptimistic: (item) => item,
    removeOptimistic: () => {},
    onOps: () => () => {},
  };
}

const PENDING = idleLive(true);
const IDLE = idleLive(false);

/**
 * The live query of `chain`, as signals. The mount holds the cache entry and starts its fetch;
 * readers read the signals in render (`useSignals`) or in `computed`s, so a row write wakes only
 * what reads it.
 */
export function useLive<T>(
  chain: QueryChain<T> | null | undefined,
  options: UseQueryOptions = {},
): Live<T> {
  const client = useParcae();
  const { status: sessionStatus, userId } = useSession();

  const subscribe = options.subscribe !== false;

  // Hold off building a key until the session has resolved. Identity
  // is required for both correctness (queries scope by user) and key
  // stability (we can't change keys mid-flight just because the
  // session is still pending). Once the session resolves (anonymous
  // or authenticated), the key is final until userId changes.
  const sessionReady = sessionStatus !== "pending";
  const canQuery =
    sessionStatus === "anonymous" || sessionStatus === "authenticated";
  const key = canQuery
    ? buildKey(chain?.__modelType, userId, chain?.__steps, subscribe)
    : null;

  const chainRef = useRef(chain);
  chainRef.current = chain;

  useEffect(() => {
    if (!key) return;
    const entry = getOrCreate(client, key, subscribe);
    hold(entry);
    return () => release(entry);
  }, [client, key, subscribe]);

  // First-time fetch on key change.
  useEffect(() => {
    if (!key) return;
    const currentChain = chainRef.current;
    if (!currentChain) return;

    const entry = getOrCreate(client, key, subscribe);
    entry.retryCount = 0;
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }

    // Refetch an empty entry unless something is already working on it.
    // Keying off `loading`/`error` instead stranded the entry: a resync
    // that superseded an in-flight fetch leaves `loading` true with
    // nothing scheduled, and a mount that trusts that flag issues no
    // request, so the screen pulses a skeleton for the life of the
    // process. Ownership is what the guard has to test, not appearance.
    const idle = !entry.fetchPromise && !entry.retryTimer && !entry.resyncPending;
    if (!entry.chain) {
      void doFetch(key, entry, currentChain, client);
    } else if (!entry.loaded && idle) {
      void doFetch(key, entry, currentChain, client);
    }
  }, [client, key, subscribe]);

  // A render reads its entry before the mount holds it; an entry no mount claims is collected.
  const entry = key ? getOrCreate(client, key, subscribe) : null;
  if (entry) collectLater(entry);
  const live: Live<T> = entry ? liveOf(entry) : sessionReady ? IDLE : PENDING;

  // ── Stuck-loading diagnostic ───────────────────────────────────
  // A query loading this long is stuck: the session never resolved
  // (no key can be built) or the fetch/subscribe hung. Emit once per
  // mount through the client; the app decides how to report.
  useEffect(
    () =>
      effect(() => {
        if (!live.loading.value) return;
        const startedAt = Date.now();
        const timer = setTimeout(() => {
          const currentClient: any = client;
          try {
            currentClient?._emitDiagnostic?.("query-stuck", {
              modelType: chainRef.current?.__modelType ?? "unknown",
              elapsedMs: Date.now() - startedAt,
              sessionStatus: currentClient?.session?.state?.status ?? "unknown",
            });
          } catch {
            log.warn("useQuery: stuck diagnostic emit failed");
          }
        }, QUERY_STUCK_MS);
        return () => clearTimeout(timer);
      }),
    [client, live],
  );

  // ── Drift poll ─────────────────────────────────────────────────
  const pollMs = options.poll ?? 0;
  useEffect(() => {
    if (!key) return;
    const entry = getOrCreate(client, key, subscribe);
    return registerPoll(entry, pollMs);
  }, [client, key, pollMs, subscribe]);

  return live;
}

/** The live query of `chain`; the component renders again whenever its state moves. */
export function useQuery<T>(
  chain: QueryChain<T> | null | undefined,
  options: UseQueryOptions = {},
): UseQueryResult<T> {
  const live = useLive(chain, options);
  const state = useSignalValue(live.state);
  return useMemo(
    () => ({
      items: state.items,
      loading: state.loading,
      error: state.error,
      total: state.total,
      refetch: live.refetch,
      addOptimistic: live.addOptimistic,
      removeOptimistic: live.removeOptimistic,
      onOps: live.onOps,
    }),
    [live, state],
  );
}

// ── prefetch ───────────────────────────────────────────────────────────────

export interface PrefetchOptions {
  /** Wait for the session to resolve before building the cache key. Default `true`. */
  waitForSession?: boolean;
  /**
   * When `false`, the prefetch is treated as static — same semantics
   * as `useQuery({ subscribe: false })`. The wire request carries
   * `__subscribe: false`, the backend skips `QuerySubscriptionManager
   * .subscribe`, and the resulting cache entry never has a
   * `queryHash`. Use this when prefetching for SSR / warm-cache of a
   * chain whose matching `useQuery` will also be `{ subscribe: false }`
   * — otherwise the two will produce separate cache entries because
   * `subscribe` is part of the cache key. Default `true`.
   */
  subscribe?: boolean;
}

export async function prefetch<T>(
  client: ParcaeClient,
  chain: QueryChain<T>,
  options: PrefetchOptions = {},
): Promise<T[]> {
  const waitForSession = options.waitForSession ?? true;
  const subscribe = options.subscribe !== false;

  if (waitForSession) {
    await client.session.ready;
  }
  if (client.session.state.status === "terminated") {
    throw new Error("prefetch: session is terminated");
  }

  const userId = client.session.state.userId;
  const modelType = (chain as any).__modelType;
  if (!modelType) {
    throw new Error(
      "prefetch: chain has no __modelType — was it built from a real Model class?",
    );
  }
  const key = buildKey(modelType, userId, (chain as any).__steps, subscribe);
  if (!key) throw new Error("prefetch: failed to build cache key");

  const entry = getOrCreate(client, key, subscribe);
  hold(entry);

  return new Promise<T[]>((resolve, reject) => {
    let settled = false;
    let stop: (() => void) | undefined;

    const settle = (value: T[] | Error) => {
      if (settled) return;
      settled = true;
      release(entry);
      stop?.();
      if (value instanceof Error) reject(value);
      else resolve(value);
    };

    if (entry.error) {
      settle(entry.error);
      return;
    }
    // A completed list response is usable even when an older backend
    // does not return a subscription hash.
    if (!entry.loading && entry.chain !== null) {
      settle(entry.items as T[]);
      return;
    }

    let first = true;
    stop = effect(() => {
      void entry.state.value;
      if (first) first = false;
      else if (entry.error) settle(entry.error);
      else if (!entry.loading) settle(entry.items as T[]);
    });

    if (!entry.chain) {
      void doFetch(key, entry, chain as any, client);
    }
  });
}

/** @internal — exposed so the Provider can drive evictions. */
export function _purgeCacheForUser(
  client: ParcaeClient,
  prevUserId: string | null,
  nextUserId?: string | null,
): void {
  purgeCacheForUser(client, prevUserId, nextUserId);
}

/** @internal */
export const __test = {
  resetCache(): void {
    caches = new WeakMap();
    stalePools = new WeakMap();
  },
  getEntry(client: ParcaeClient, key: string): CacheEntry | undefined {
    return caches.get(client)?.get(key);
  },
  buildKey(
    modelType: string,
    userId: string | null,
    steps: unknown[],
    subscribe = true,
  ): string {
    return buildKey(modelType, userId, steps as any[], subscribe) as string;
  },
  fetch(
    key: string,
    chain: QueryChain<any>,
    client: ParcaeClient,
    subscribe?: boolean,
  ): CacheEntry {
    const entry = getOrCreate(client, key, subscribe);
    void doFetch(key, entry, chain, client);
    return entry;
  },
  retain(
    client: ParcaeClient,
    key: string,
    onChange: () => void,
    subscribe?: boolean,
  ): () => void {
    const entry = getOrCreate(client, key, subscribe);
    entry.refs++;
    let first = true;
    const stop = effect(() => {
      void entry.state.value;
      if (first) first = false;
      else onChange();
    });
    return () => {
      stop();
      entry.refs--;
    };
  },
  getMergedItems(entry: CacheEntry): any[] {
    return getMergedItems(entry);
  },
  onResyncRequired(client: ParcaeClient): void {
    _onResyncRequired(client);
  },
};
