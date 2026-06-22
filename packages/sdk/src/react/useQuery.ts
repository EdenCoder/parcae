"use client";

import { Model, SYM_SERVER_MERGE, generateId } from "@parcae/model";
import { applyPatch, type Operation } from "fast-json-patch";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { ParcaeClient } from "../client";
import { log } from "../log";
import { useParcae } from "./context";
import { useSession } from "./useSession";

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
   * hidden or the transport is disconnected. Default 60_000, set to
   * 0 to disable.
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

interface UseQueryResult<T> {
  items: T[];
  loading: boolean;
  error: Error | null;
  /** Total matching records on the server (before limit/offset). */
  total: number;
  refetch: () => void;
  addOptimistic: (item: T | Record<string, any>) => T;
  removeOptimistic: (item: T | string) => void;
  onOps: (listener: (ops: QueryOp[]) => void) => () => void;
}

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  items: any[];
  optimistic: any[];
  mergedItems: any[];
  mergedKey: string;
  loading: boolean;
  error: Error | null;
  hash: string;
  version: number;
  refs: number;
  listeners: Set<() => void>;
  dispose: (() => void) | null;
  gcTimer: ReturnType<typeof setTimeout> | null;
  queryHash: string | null;
  totalCount: number;
  chain: QueryChain<any> | null;
  client: ParcaeClient | null;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
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

const cache = new Map<string, CacheEntry>();
const GC_DELAY = 60_000;
const EMPTY: any[] = [];
const INITIAL_HASH = "L";

/**
 * Drop every cache entry whose key was generated for a different user
 * than `currentUserId`. Used on session transitions (sign-out → null;
 * user switch → new userId).
 */
function purgeCacheForUser(prevUserId: string | null): void {
  if (prevUserId === null) return;
  const needle = `:${prevUserId}:`;
  for (const [key, entry] of cache) {
    if (!key.includes(needle)) continue;
    entry.dispose?.();
    if (entry.gcTimer) clearTimeout(entry.gcTimer);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    cache.delete(key);
  }
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1_000, 3_000, 10_000];

function buildHash(e: CacheEntry): string {
  if (e.loading) return "L";
  if (e.error) return `E:${e.error.message}`;
  return `D:v${e.version}:o${e.optimistic.length}:i${e.items.length}`;
}

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

function getOrCreate(key: string, subscribe?: boolean): CacheEntry {
  let e = cache.get(key);
  if (!e) {
    // Derive from the key suffix when not passed explicitly. Lets
    // `addOptimistic` / `refetch` / `__test.fetch` callers stay
    // ignorant of the subscribe contract — the key already encodes
    // it (see `buildKey`'s `:nosub` suffix). Prevents a GC'd entry
    // from being re-created with the wrong mode.
    const resolved = subscribe ?? !key.endsWith(":nosub");
    e = {
      items: EMPTY,
      optimistic: [],
      mergedItems: EMPTY,
      mergedKey: "0:0",
      loading: true,
      error: null,
      hash: INITIAL_HASH,
      version: 0,
      refs: 0,
      listeners: new Set(),
      dispose: null,
      gcTimer: null,
      queryHash: null,
      totalCount: 0,
      chain: null,
      client: null,
      retryCount: 0,
      retryTimer: null,
      opsListeners: new Set(),
      subscribe: resolved,
    };
    cache.set(key, e);
  }
  return e;
}

function notify(e: CacheEntry): void {
  const next = buildHash(e);
  if (next !== e.hash) {
    e.hash = next;
    for (const fn of e.listeners) fn();
  }
}

// ── Patch helpers ────────────────────────────────────────────────────────────

function isArrayIndexSegment(seg: string | undefined): boolean {
  return seg === "-" || (seg !== undefined && /^\d+$/.test(seg));
}

function ensureIntermediates(
  doc: Record<string, any>,
  patches: readonly { path: string }[],
): void {
  for (const { path } of patches) {
    const segments = path.split("/").filter(Boolean);
    let cursor: any = doc;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      const val = cursor[seg];
      if (val === null || val === undefined || typeof val !== "object") {
        cursor[seg] = isArrayIndexSegment(segments[i + 1]) ? [] : {};
      }
      cursor = cursor[seg];
    }
  }
}

// ── Ops application ─────────────────────────────────────────────────────────

type QueryOp =
  | { op: "add"; id: string; data: Record<string, any> }
  | { op: "remove"; id: string }
  | { op: "update"; id: string; patch: Operation[] };

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
  const updateOps = new Map<string, Operation[]>();
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
    const filtered =
      pendingPaths && pendingPaths.size > 0
        ? patches.filter((p) => !pendingPaths.has(p.path))
        : patches;

    if (filtered.length === 0) continue;

    const snapshot = structuredClone(existing.__data ?? {});
    ensureIntermediates(snapshot, filtered);
    applyPatch(snapshot, filtered, false, true);

    if (typeof existing[SYM_SERVER_MERGE] === "function") {
      existing[SYM_SERVER_MERGE](snapshot);
    } else {
      for (const [k, v] of Object.entries(snapshot)) {
        existing[k] = v;
      }
    }
    didUpdate = true;
  }

  if (!hasRemoves && !hasAdds && !didUpdate) {
    return { items, changed: false };
  }

  if (!hasRemoves && !hasAdds) {
    // Update-only frame (DOL-1101). The models in the array were
    // mutated in place via `SYM_SERVER_MERGE`; the array slot
    // identity doesn't need to flip. Consumers that care about
    // field-level reactivity wake through parcae's per-model
    // `change` event bus (`useModelAtomic`). Consumers reading the
    // `items` array bail on `Object.is(prev, next)` and skip the
    // re-render — exactly what we want for status / readAt / file
    // patches that don't move membership.
    //
    // Returning `changed: true` keeps `entry.version++` ticking so
    // downstream code that meters "did SOMETHING happen on this
    // query" still sees the bump.
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
    const optimistic = serverTmp ? optimisticByTmp.get(serverTmp) : null;

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

function reconcile(prev: any[], next: any[], entry?: CacheEntry): any[] {
  if (prev === EMPTY || prev.length === 0) {
    if (entry?.optimistic.length) drainOptimistic(next, entry);
    return next;
  }

  const prevById = new Map<string, any>();
  for (const item of prev) prevById.set(item.id, item);

  let membershipChanged = false;
  const result: any[] = new Array(next.length);

  for (let i = 0; i < next.length; i++) {
    const fresh = next[i];
    const existing = prevById.get(fresh.id);
    if (existing) {
      if (typeof existing[SYM_SERVER_MERGE] === "function") {
        const freshData = fresh.__data ?? fresh;
        existing[SYM_SERVER_MERGE](freshData);
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

  if (entry?.optimistic.length) drainOptimistic(next, entry);

  if (!membershipChanged && prev.length === next.length) return prev;
  return result;
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

function resolveAdapter(chain: QueryChain<any>): any {
  return chain.__adapter ?? (Model.hasAdapter() ? Model.getAdapter() : null);
}

// ── Fetch + subscribe ───────────────────────────────────────────────────────

function scheduleRetry(key: string, entry: CacheEntry): void {
  if (entry.retryCount >= MAX_RETRIES) return;
  if (!entry.chain || !entry.client) return;
  if (entry.refs <= 0) return;

  const delay =
    RETRY_DELAYS[Math.min(entry.retryCount, RETRY_DELAYS.length - 1)]!;
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    if (entry.refs <= 0 || !entry.chain || !entry.client) return;
    entry.retryCount++;
    doFetch(key, entry, entry.chain, entry.client);
  }, delay);
}

function doFetch(
  key: string,
  entry: CacheEntry,
  chain: QueryChain<any>,
  client: ParcaeClient,
  opts: { force?: boolean } = {},
): void {
  log.debug("useQuery: fetching", chain.__modelType);

  entry.chain = chain;
  entry.client = client;
  if (entry.items === EMPTY) entry.loading = true;
  entry.error = null;
  notify(entry);

  let fetchChain: QueryChain<any> = chain;
  if (opts.force && typeof fetchChain.withForceRefresh === "function") {
    fetchChain = fetchChain.withForceRefresh();
  }
  if (entry.subscribe === false && typeof fetchChain.withSubscribe === "function") {
    fetchChain = fetchChain.withSubscribe(false);
  }

  fetchChain
    .find()
    .then((result: any[]) => {
      const hash = (result as any).__queryHash;
      const prevItems = entry.items;
      entry.items = reconcile(entry.items, result, entry);
      if (entry.items !== prevItems) entry.version++;
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

      // `entry.subscribe === false` is the static-query opt-out; the
      // backend should never have returned a hash for these, but
      // gate defensively so a misbehaving backend can't trick us
      // into attaching a `query:${hash}` listener anyway.
      if (hash && hash !== entry.queryHash && entry.subscribe !== false) {
        entry.dispose?.();
        entry.queryHash = hash;

        const adapter = resolveAdapter(chain);

        const unsub = client.subscribe(`query:${hash}`, (payload: unknown) => {
          const parsed = normalizeOpsPayload(payload);
          if (!parsed) return;
          const { ops, order } = parsed;
          if (ops.length === 0 && !order) return;
          const result = applyOps(
            entry.items,
            ops,
            chain.__modelClass,
            adapter,
            entry,
          );
          let items = result.items;
          let changed = result.changed;
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
        });
        entry.dispose = unsub;
      }

      notify(entry);
    })
    .catch((err: Error) => {
      log.error("useQuery: error", err.message);
      entry.error = err;
      entry.loading = false;
      notify(entry);
      scheduleRetry(key, entry);
    });
}

// ── Resync handler ──────────────────────────────────────────────────────────

/**
 * Called by ParcaeProvider after the transport's hello handshake
 * lands on a (re)connection. Fires a batched `resync` RPC for every
 * cache entry that has a live subscription, restoring server-side
 * subscription state in one round trip. Entries with no `queryHash`
 * (never fetched) are handled by the `[key]` mount effect instead.
 */
export function _onResyncRequired(client: ParcaeClient): void {
  const entries: {
    cacheKey: string;
    modelType: string;
    steps: unknown[];
    queryHash: string | null;
    subscribe: boolean;
  }[] = [];

  for (const [cacheKey, entry] of cache) {
    if (entry.refs <= 0) continue;
    if (!entry.chain) continue;
    const modelType = entry.chain.__modelType;
    if (!modelType) continue;
    entries.push({
      cacheKey,
      modelType,
      steps: entry.chain.__steps ?? [],
      queryHash: entry.queryHash,
      subscribe: entry.subscribe,
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
      })),
    )
    .then((results) => {
      const byKey = new Map(results.map((r) => [r.key, r]));
      for (const e of entries) {
        const result = byKey.get(e.cacheKey);
        const entry = cache.get(e.cacheKey);
        if (!entry || !result) continue;

        const items = result.items as any[];
        const adapter = entry.chain ? resolveAdapter(entry.chain) : null;
        const ModelClass = entry.chain?.__modelClass;
        const hydrated = ModelClass
          ? items.map((row) => ModelClass.hydrate(adapter, row))
          : items;

        const prevItems = entry.items;
        entry.items = reconcile(prevItems, hydrated, entry);
        if (entry.items !== prevItems) entry.version++;
        if (entry.totalCount !== result.totalCount) {
          entry.totalCount = result.totalCount;
          entry.version++;
        }
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
        if (
          result.hash &&
          result.hash !== entry.queryHash &&
          entry.client &&
          entry.subscribe !== false
        ) {
          entry.dispose?.();
          entry.queryHash = result.hash;
          const subClient = entry.client;
          const chain = entry.chain!;
          const unsub = subClient.subscribe(
            `query:${result.hash}`,
            (payload: unknown) => {
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
              let nextItems = applied.items;
              let changed = applied.changed;
              if (order) {
                const reordered = reorderByIds(nextItems, order);
                if (reordered) {
                  nextItems = reordered;
                  changed = true;
                }
              }
              if (!changed) return;
              entry.items = nextItems;
              entry.version++;
              notify(entry);
              for (const listener of entry.opsListeners) {
                try {
                  listener(ops);
                } catch {}
              }
            },
          );
          entry.dispose = unsub;
        }

        notify(entry);
      }
    })
    .catch((err) => {
      log.error("useQuery: resync failed:", err.message);
    });
}

// ── useQuery ───────────────────────────────────────────────────────────────

/**
 * Serialize one step's args into a JSON-safe form for the cache key.
 *
 * A `.where(callback)` step records the callback FUNCTION in its args
 * (see `lazyQuery` in @parcae/model). `JSON.stringify` turns a function
 * into `null`, so two callbacks that close over different values
 * (`name ilike %Jane%` vs `%Jill%`) serialize identically and collide
 * on one cache entry — the query then never refetches when the
 * closed-over value changes, because the cache key is unchanged. Mirror
 * the wire serialization (the FrontendAdapter's `{ __nested: steps }`
 * recorder) by replaying the callback against a recording proxy so the
 * nested builder calls, and the values they close over, land in the key.
 */
function serializeStepArgs(args: any[]): any[] {
  return args.map((arg) => {
    if (typeof arg !== "function") return arg;
    const nested: { method: string; args: any[] }[] = [];
    const recorder: any = new Proxy(
      {},
      {
        get:
          (_t, method: string | symbol) =>
          (...innerArgs: any[]) => {
            if (typeof method === "string") {
              nested.push({ method, args: serializeStepArgs(innerArgs) });
            }
            return recorder;
          },
      },
    );
    try {
      arg(recorder);
    } catch {
      // A callback that isn't a plain builder chain can't be captured;
      // fall back to a stable marker so it stays distinct from a
      // non-function arg without throwing in the render path.
      return { __nested: "__opaque__" };
    }
    return { __nested: nested };
  });
}

function serializeStepsForKey(steps: any[] | undefined): string {
  return JSON.stringify(
    (steps ?? []).map((s) => ({
      method: s?.method,
      args: serializeStepArgs(s?.args ?? []),
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

export function useQuery<T>(
  chain: QueryChain<T> | null | undefined,
  options: UseQueryOptions = {},
): UseQueryResult<T> {
  const client = useParcae();
  const { status: sessionStatus, userId } = useSession();

  const subscribe = options.subscribe !== false;

  // Hold off building a key until the session has resolved. Identity
  // is required for both correctness (queries scope by user) and key
  // stability (we can't change keys mid-flight just because the
  // session is still pending). Once the session resolves (anonymous
  // or authenticated), the key is final until userId changes.
  const sessionReady = sessionStatus !== "pending";
  const key = sessionReady
    ? buildKey(chain?.__modelType, userId, chain?.__steps, subscribe)
    : null;

  const chainRef = useRef(chain);
  chainRef.current = chain;
  const clientRef = useRef(client);
  clientRef.current = client;
  const keyRef = useRef(key);
  keyRef.current = key;

  const subscribeToCache = useCallback(
    (onChange: () => void) => {
      if (!key) return () => {};
      const e = getOrCreate(key, subscribe);
      e.refs++;
      e.listeners.add(onChange);
      if (e.gcTimer) {
        clearTimeout(e.gcTimer);
        e.gcTimer = null;
      }
      return () => {
        e.listeners.delete(onChange);
        e.refs--;
        if (e.refs <= 0) {
          if (e.retryTimer) {
            clearTimeout(e.retryTimer);
            e.retryTimer = null;
          }
          e.gcTimer = setTimeout(() => {
            e.dispose?.();
            cache.delete(key);
          }, GC_DELAY);
        }
      };
    },
    [key],
  );

  const getSnapshot = useCallback((): string => {
    if (!key) return INITIAL_HASH;
    return cache.get(key)?.hash ?? INITIAL_HASH;
  }, [key]);

  useSyncExternalStore(subscribeToCache, getSnapshot, getSnapshot);

  // First-time fetch on key change.
  useEffect(() => {
    if (!key) return;
    const currentChain = chainRef.current;
    if (!currentChain) return;

    const entry = getOrCreate(key, subscribe);
    entry.retryCount = 0;
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }

    if (!entry.chain) {
      doFetch(key, entry, currentChain, clientRef.current);
    } else if (entry.items === EMPTY && !entry.loading && !entry.error) {
      doFetch(key, entry, currentChain, clientRef.current);
    }
  }, [key]);

  // ── Drift poll ─────────────────────────────────────────────────
  const pollMs = options.poll ?? 60_000;
  useEffect(() => {
    if (!key) return;
    if (pollMs <= 0) return;
    if (typeof setInterval !== "function") return;

    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      const k = keyRef.current;
      const currentChain = chainRef.current;
      if (!k || !currentChain) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      if (clientRef.current.isConnected === false) return;
      const entry = cache.get(k);
      if (!entry) return;
      if (entry.refs <= 0) return;
      doFetch(k, entry, currentChain, clientRef.current, { force: true });
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(tick, pollMs);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    start();

    const onVisibility = () => {
      if (stopped) return;
      if (typeof document === "undefined") return;
      if (document.visibilityState === "visible") {
        tick();
        start();
      } else {
        stop();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      stopped = true;
      stop();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [key, pollMs]);

  const refetch = useCallback(() => {
    const k = keyRef.current;
    const currentChain = chainRef.current;
    if (!k || !currentChain) return;
    const entry = getOrCreate(k);
    entry.retryCount = 0;
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    doFetch(k, entry, currentChain, clientRef.current);
  }, []);

  const addOptimistic = useCallback((item: T | Record<string, any>): T => {
    const k = keyRef.current;
    if (!k) return item as T;
    const entry = getOrCreate(k);
    const ModelClass = chainRef.current?.__modelClass;

    let instance: any;
    if (item instanceof Model) {
      instance = item;
    } else if (ModelClass) {
      instance = ModelClass.create(item);
    } else {
      instance = item;
    }

    if (!instance.tmp) instance.tmp = generateId();

    entry.optimistic.push(instance);
    entry.version++;
    notify(entry);
    return instance as T;
  }, []);

  const removeOptimistic = useCallback((item: T | string): void => {
    const k = keyRef.current;
    if (!k) return;
    const entry = cache.get(k);
    if (!entry) return;

    const match =
      typeof item === "string"
        ? (o: any) => o.tmp !== item && o.id !== item
        : (o: any) => o !== item && o.tmp !== (item as any).tmp;

    const before = entry.optimistic.length;
    entry.optimistic = entry.optimistic.filter(match);
    if (entry.optimistic.length !== before) {
      entry.version++;
      notify(entry);
    }
  }, []);

  const noop = useCallback(() => {}, []);
  const noopAdd = useCallback((item: T | Record<string, any>) => item as T, []);

  const entryForOps = key ? cache.get(key) : undefined;
  const onOps = useCallback(
    (listener: (ops: QueryOp[]) => void): (() => void) => {
      if (!entryForOps) return () => {};
      entryForOps.opsListeners.add(listener);
      return () => {
        entryForOps.opsListeners.delete(listener);
      };
    },
    [entryForOps],
  );

  // ── Stable result memoization ─────────────────────────────────
  const resultRef = useRef<UseQueryResult<T> | null>(null);
  const resultHashRef = useRef<string>("");
  const entry = key ? cache.get(key) : undefined;
  const observableHash = `${key ?? ""}|${entry?.hash ?? "L"}`;

  if (resultRef.current && resultHashRef.current === observableHash) {
    return resultRef.current;
  }

  let next: UseQueryResult<T>;
  if (!key) {
    next = {
      items: EMPTY as T[],
      loading: !sessionReady,
      error: null,
      total: 0,
      refetch: noop,
      addOptimistic: noopAdd,
      removeOptimistic: noop,
      onOps,
    };
  } else {
    const items: T[] = entry ? (getMergedItems(entry) as T[]) : (EMPTY as T[]);
    next = {
      items,
      loading: entry?.loading ?? true,
      error: entry?.error ?? null,
      total: entry?.totalCount ?? 0,
      refetch,
      addOptimistic,
      removeOptimistic,
      onOps,
    };
  }
  resultRef.current = next;
  resultHashRef.current = observableHash;
  return next;
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

  const userId = client.session.state.userId;
  const modelType = (chain as any).__modelType;
  if (!modelType) {
    throw new Error(
      "prefetch: chain has no __modelType — was it built from a real Model class?",
    );
  }
  const key = buildKey(modelType, userId, (chain as any).__steps, subscribe);
  if (!key) throw new Error("prefetch: failed to build cache key");

  const entry = getOrCreate(key, subscribe);

  entry.refs++;
  if (entry.gcTimer) {
    clearTimeout(entry.gcTimer);
    entry.gcTimer = null;
  }

  return new Promise<T[]>((resolve, reject) => {
    let settled = false;

    const release = () => {
      entry.refs--;
      if (entry.refs <= 0) {
        entry.gcTimer = setTimeout(() => {
          entry.dispose?.();
          cache.delete(key);
        }, GC_DELAY);
      }
    };

    const settle = (value: T[] | Error) => {
      if (settled) return;
      settled = true;
      entry.listeners.delete(onChange);
      release();
      if (value instanceof Error) reject(value);
      else resolve(value);
    };

    const onChange = () => {
      if (entry.error) settle(entry.error);
      else if (!entry.loading) settle(entry.items as T[]);
    };

    if (entry.error) {
      settle(entry.error);
      return;
    }
    // "Already loaded" fast path. For subscribed entries the
    // `queryHash !== null` check stands in for "the backend completed
    // the subscribe handshake" — without it we might short-circuit on
    // a half-populated entry. For static entries (`subscribe: false`)
    // there is no hash, so the fast path is just `!loading && !error`.
    const fullyLoaded = subscribe
      ? !entry.loading && entry.queryHash !== null
      : !entry.loading && entry.chain !== null;
    if (fullyLoaded) {
      settle(entry.items as T[]);
      return;
    }

    entry.listeners.add(onChange);

    if (!entry.chain) {
      doFetch(key, entry, chain as any, client);
    }
  });
}

/** @internal — exposed so the Provider can drive evictions. */
export function _purgeCacheForUser(prevUserId: string | null): void {
  purgeCacheForUser(prevUserId);
}

/** @internal */
export const __test = {
  resetCache(): void {
    for (const entry of cache.values()) {
      entry.dispose?.();
      if (entry.gcTimer) clearTimeout(entry.gcTimer);
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
    }
    cache.clear();
  },
  getEntry(key: string): CacheEntry | undefined {
    return cache.get(key);
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
    const entry = getOrCreate(key, subscribe);
    doFetch(key, entry, chain, client);
    return entry;
  },
  retain(
    key: string,
    onChange: () => void,
    subscribe?: boolean,
  ): () => void {
    const entry = getOrCreate(key, subscribe);
    entry.refs++;
    entry.listeners.add(onChange);
    return () => {
      entry.listeners.delete(onChange);
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
