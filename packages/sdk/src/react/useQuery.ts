"use client";

import { Model, SYM_SERVER_MERGE, generateId } from "@parcae/model";
import { applyPatch, type Operation } from "fast-json-patch";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { ParcaeClient } from "../client";
import { log } from "../log";
import { useParcae } from "./context";
import { useAuthStatus } from "./useAuth";

interface QueryChain<T> {
  find(): Promise<T[]>;
  __steps?: any[];
  __modelType?: string;
  __modelClass?: any;
  __adapter?: any;
}

interface UseQueryOptions {
  waitForAuth?: boolean;
}

interface UseQueryResult<T> {
  items: T[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  /** Total matching records on the server (before limit/offset). */
  total: number;
  /**
   * Add an item optimistically to the query results.
   * Accepts a Model instance or a plain data object (which will be wrapped
   * in a new Model instance automatically).
   *
   * If the item has no `tmp` field, one is generated automatically so the
   * server can reconcile the optimistic version with the real one.
   *
   * Returns the Model instance (useful when a plain object was passed in).
   */
  addOptimistic: (item: T | Record<string, any>) => T;
  /**
   * Remove an optimistic item (e.g. on save failure / rollback).
   * Matches by `tmp` or `id`.
   */
  removeOptimistic: (item: T | string) => void;
  /**
   * Register a listener for raw subscription ops.
   * Fires after the cache is updated. Returns an unsubscribe function.
   */
  onOps: (listener: (ops: QueryOp[]) => void) => () => void;
}

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  items: any[];
  /** Optimistic items awaiting server confirmation. Matched by `tmp`. */
  optimistic: any[];
  loading: boolean;
  error: Error | null;
  hash: string;
  version: number;
  refs: number;
  listeners: Set<() => void>;
  dispose: (() => void) | null;
  gcTimer: ReturnType<typeof setTimeout> | null;
  queryHash: string | null;
  /** Total matching records on the server (before limit/offset). */
  totalCount: number;
  /** The chain used for the last fetch — stored so retry/refetch don't need a closure. */
  chain: QueryChain<any> | null;
  /** The client used for the last fetch. */
  client: ParcaeClient | null;
  /** Retry state */
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** External ops listeners — called after cache is updated with raw subscription ops. */
  opsListeners: Set<(ops: QueryOp[]) => void>;
}

const cache = new Map<string, CacheEntry>();
const GC_DELAY = 60_000;
const EMPTY: any[] = [];
const INITIAL_HASH = "L"; // loading=true, no items

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1_000, 3_000, 10_000];

function buildHash(e: CacheEntry): string {
  if (e.loading) return "L";
  if (e.error) return `E:${e.error.message}`;
  let h = `D:v${e.version}:`;
  for (let i = 0; i < e.optimistic.length; i++) {
    if (i > 0) h += ",";
    h += `o:${e.optimistic[i]?.tmp ?? e.optimistic[i]?.id ?? i}`;
  }
  if (e.optimistic.length > 0 && e.items.length > 0) h += ",";
  for (let i = 0; i < e.items.length; i++) {
    if (i > 0) h += ",";
    h += e.items[i]?.id ?? i;
  }
  return h;
}

function getOrCreate(key: string): CacheEntry {
  let e = cache.get(key);
  if (!e) {
    e = {
      items: EMPTY,
      optimistic: [],
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

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * RFC 6901 array-index segment: numeric string (`"0"`, `"12"`) or
 * the append-marker `"-"`. When the NEXT path segment after a missing
 * intermediate is one of these, the intermediate must be an array.
 */
function isArrayIndexSegment(seg: string | undefined): boolean {
  return seg === "-" || (seg !== undefined && /^\d+$/.test(seg));
}

/**
 * Ensure every intermediate segment of each patch path exists on
 * `doc`. `fast-json-patch` does NOT auto-vivify parents, so a patch
 * like `{ op:"add", path:"/a/b/c" }` will throw if `doc.a` is `null`
 * or missing. We walk the path segments and replace any `null` /
 * non-object intermediates so the subsequent `applyPatch` call can
 * succeed.
 *
 * Vivification shape is decided by looking at the NEXT path segment:
 * a numeric index (or `-`) means the intermediate is an array; any
 * other key means it's a plain object. Mirrors the same rule in
 * `@parcae/model`'s ensureIntermediates so optimistic local apply
 * matches the server-side write shape.
 */
function ensureIntermediates(
  doc: Record<string, any>,
  patches: readonly { path: string }[],
): void {
  for (const { path } of patches) {
    const segments = path.split("/").filter(Boolean);
    // We only need to guarantee *parents* exist (all but the last segment).
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

// ── Ops application ──────────────────────────────────────────────────────────

type QueryOp =
  | { op: "add"; id: string; data: Record<string, any> }
  | { op: "remove"; id: string }
  | { op: "update"; id: string; patch: Operation[] };

/** Result from applyOps indicating what changed */
interface ApplyResult {
  items: any[];
  /** Whether any items were mutated in-place or membership changed */
  changed: boolean;
}

function applyOps(
  items: any[],
  ops: QueryOp[],
  modelClass: any,
  adapter: any,
  entry?: CacheEntry,
): ApplyResult {
  // Fast path: nothing to do
  if (ops.length === 0) return { items, changed: false };

  // Collect which IDs are touched and how
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
          if (existing) {
            existing.push(...op.patch);
          } else {
            updateOps.set(op.id, [...op.patch]);
          }
        }
        break;
      case "remove":
        removeIds.add(op.id);
        break;
    }
  }

  // Index existing items
  const byId = new Map<string, any>();
  for (const item of items) byId.set(item.id, item);

  // Index optimistic items by tmp for reconciliation
  const optimisticByTmp = new Map<string, any>();
  if (entry?.optimistic) {
    for (const item of entry.optimistic) {
      if (item.tmp) optimisticByTmp.set(item.tmp, item);
    }
  }

  const hasRemoves = removeIds.size > 0;
  const hasAdds = addOps.size > 0;

  // Apply updates atomically — mutate existing instances in-place via
  // SYM_SERVER_MERGE. Model identity is STABLE across merges (the
  // cached Proxy is reused). For components that subscribe via
  // `useModel(model)` / `useModelAtomic(model, path)`, re-render is
  // scoped to the specific model that changed. For components that
  // still consume `useQuery` directly, bumping the entry version
  // below keeps the original cascade-re-render behaviour so non-
  // migrated consumers still see updates — useModel/useModelAtomic
  // is an opt-in path, not a required migration.
  let didUpdate = false;
  for (const [id, patches] of updateOps) {
    let existing = byId.get(id);
    if (!existing && entry?.optimistic) {
      existing = entry.optimistic.find((o: any) => o.id === id);
    }
    if (!existing) continue;

    // Filter out patches whose exact path is currently in-flight from
    // a local patch() call. This prevents the server echo from
    // overwriting optimistic local state for those specific sub-paths,
    // while letting all other server updates (e.g. background jobs
    // writing to different sub-paths) flow through immediately.
    const pendingPaths: ReadonlySet<string> | undefined =
      existing.__patchingPaths;
    const filtered =
      pendingPaths && pendingPaths.size > 0
        ? patches.filter((p) => !pendingPaths.has(p.path))
        : patches;

    if (filtered.length === 0) continue;

    // Build the full server-authoritative snapshot by applying the RFC
    // 6902 patches onto a deep clone of the current data.
    const snapshot = JSON.parse(JSON.stringify(existing.__data ?? {}));
    ensureIntermediates(snapshot, filtered);
    applyPatch(snapshot, filtered, false, true);

    // Merge in place. `this` is stable, so the items array entry
    // never needs to be swapped — SYM_SERVER_MERGE mutates the same
    // instance we already hold.
    if (typeof existing[SYM_SERVER_MERGE] === "function") {
      existing[SYM_SERVER_MERGE](snapshot);
    } else {
      // Fallback (non-Model optimistic items)
      for (const [k, v] of Object.entries(snapshot)) {
        existing[k] = v;
      }
    }
    didUpdate = true;
  }

  if (!hasRemoves && !hasAdds && !didUpdate) {
    return { items, changed: false };
  }

  // For update-only ops, return a NEW array reference (shallow copy).
  // Per-item Model identity is still stable — SYM_SERVER_MERGE mutated
  // the existing instances in place, so `React.memo(Row, item)` rows
  // are still ref-equal and short-circuit cleanly. Only the wrapping
  // array is fresh, which is what downstream `useMemo([items])` and
  // derived-state computations need to invalidate.
  //
  // Without the new reference, consumers like
  //   const rows = useMemo(() => items.map(toRow), [items])
  // see the same items reference and return the cached `rows`, even
  // though individual model fields just mutated. The `useSyncExternalStore`
  // re-render fires (because cache.hash bumps via version++), but the
  // memoized derived state is stale, so the rendered UI doesn't reflect
  // the mutation. This was reproducible on Freia's chat screen: an
  // `assistant-log-confirm` chip transitioned to `-done` server-side,
  // the update op was received and applied (changed=true), but the chip
  // visually stayed in pre-save state because `useMemo([rawMessages])`
  // returned the cached rows. Slicing on update breaks that cycle.
  if (!hasRemoves && !hasAdds) {
    return { items: items.slice(), changed: true };
  }

  const result: any[] = [];

  for (const item of items) {
    const id = item.id;
    if (removeIds.has(id)) continue;
    result.push(item);
  }

  for (const [id, data] of addOps) {
    if (byId.has(id)) continue;

    // Reconcile with optimistic items by tmp match.
    // If a server add has a `tmp` matching an optimistic item, merge the
    // server data into the existing optimistic instance (giving it the
    // real id, server timestamps, etc.) and move it from optimistic → items.
    const serverTmp = data.tmp;
    const optimistic = serverTmp ? optimisticByTmp.get(serverTmp) : null;

    if (optimistic) {
      // Merge server data into the optimistic instance in-place. The
      // method returns `this`, so identity stays stable — the item we
      // push into `result` is the same reference the rest of the app
      // already holds.
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

  // Drain optimistic items that have been confirmed (present in result)
  // or removed by the server (present in removeIds).
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

/**
 * Reconcile a fresh fetch result with the previous items array.
 * For items that exist in both, merges server data into the existing
 * instance in-place via SYM_SERVER_MERGE (preserves local pending
 * changes, preserves Proxy identity, emits "change" when data
 * actually differs).
 *
 * The returned array only has a NEW reference when membership or
 * order changed — same-membership same-order same-identity returns
 * `prev` unchanged. Per-item reactivity is handled by
 * `useModel(model)` subscribing to the model's "change" event.
 */
function reconcile(prev: any[], next: any[], entry?: CacheEntry): any[] {
  if (prev === EMPTY || prev.length === 0) {
    if (entry?.optimistic.length) {
      drainOptimistic(next, entry);
    }
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
      // Merge server data in-place — `this` identity is stable, so
      // the items array entry stays referentially equal.
      if (typeof existing[SYM_SERVER_MERGE] === "function") {
        const freshData = fresh.__data ?? fresh;
        existing[SYM_SERVER_MERGE](freshData);
      }
      result[i] = existing;
      // Order change still counts as membership change.
      if (!membershipChanged && prev[i]?.id !== fresh.id) {
        membershipChanged = true;
      }
    } else {
      result[i] = fresh;
      membershipChanged = true;
    }
  }

  if (entry?.optimistic.length) {
    drainOptimistic(next, entry);
  }

  if (!membershipChanged && prev.length === next.length) return prev;
  return result;
}

/**
 * Remove optimistic items that have been confirmed by the server.
 * Matches by both `id` and `tmp` — if any server item shares the same
 * `id` or `tmp`, the optimistic version is removed.
 */
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

// ── Fetch + subscribe ────────────────────────────────────────────────────────

function scheduleRetry(key: string, entry: CacheEntry): void {
  if (entry.retryCount >= MAX_RETRIES) return;
  if (!entry.chain || !entry.client) return;
  // Don't retry if nobody is listening
  if (entry.refs <= 0) return;

  const delay =
    RETRY_DELAYS[Math.min(entry.retryCount, RETRY_DELAYS.length - 1)]!;
  log.debug(
    `useQuery: scheduling retry ${entry.retryCount + 1}/${MAX_RETRIES} in ${delay}ms`,
  );

  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    // Check again that someone is still listening
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
): void {
  log.debug("useQuery: fetching", chain.__modelType);

  // Store chain/client on the entry so retry and refetch can access them
  // without needing the original closure.
  entry.chain = chain;
  entry.client = client;
  if (entry.items === EMPTY) {
    entry.loading = true;
  }
  entry.error = null;
  notify(entry);

  chain
    .find()
    .then((result: any[]) => {
      log.debug("useQuery: got", result.length, "items for", chain.__modelType);
      entry.items = reconcile(entry.items, result, entry);
      entry.loading = false;
      entry.retryCount = 0; // Reset retries on success
      // Capture totalCount from the server response (set by FrontendAdapter)
      if (typeof (result as any).__totalCount === "number") {
        entry.totalCount = (result as any).__totalCount;
      }
      if (entry.retryTimer) {
        clearTimeout(entry.retryTimer);
        entry.retryTimer = null;
      }

      // Pick up the query subscription hash from the backend response
      const hash = (result as any).__queryHash;
      if (hash && hash !== entry.queryHash) {
        entry.dispose?.();
        entry.queryHash = hash;

        const adapter = resolveAdapter(chain);

        const unsub = client.subscribe(`query:${hash}`, (ops: QueryOp[]) => {
          log.info(
            `[useQuery] query:${hash.slice(0, 8)} received`,
            Array.isArray(ops) ? ops.length : "non-array",
            "op(s)",
          );
          if (!Array.isArray(ops) || ops.length === 0) return;
          const result = applyOps(
            entry.items,
            ops,
            chain.__modelClass,
            adapter,
            entry,
          );
          if (!result.changed) {
            log.info(
              `[useQuery] query:${hash.slice(0, 8)} applyOps returned no change`,
            );
            return;
          }
          entry.items = result.items;
          entry.version++;
          notify(entry);
          // Fire ops listeners after cache is updated
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

      // Auto-retry on failure
      scheduleRetry(key, entry);
    });
}

// ── useQuery ─────────────────────────────────────────────────────────────────

export function useQuery<T>(
  chain: QueryChain<T> | null | undefined,
  options: UseQueryOptions = {},
): UseQueryResult<T> {
  const client = useParcae();
  const waitForAuth = options.waitForAuth ?? true;
  const { status: authStatus, userId } = useAuthStatus();
  // Strictly require "authenticated" rather than "anything but pending".
  // Treating "unauthenticated" as ready races the socket session: the
  // initial fetch goes over HTTP without a socket id, the server's
  // QuerySubscriptionManager has no socket to register against, and
  // subsequent model-change pushes have no subscriber to emit to. The
  // realtime-on-reconnect path covers reconnect but not "never
  // subscribed in the first place"; gating on "authenticated" forces
  // the fetch to wait for the socket session to land.
  const authReady = !waitForAuth || authStatus === "authenticated";

  // Compute the "live" key when auth is ready.
  const liveKey =
    chain && authReady
      ? `${chain.__modelType}:${userId ?? "anon"}:${JSON.stringify(chain.__steps ?? [])}`
      : null;

  // Hold on to the last valid key so we keep showing stale data during
  // disconnects (when auth temporarily resets to "pending").  Only null
  // the key out if we've *never* had a valid key (initial auth pending).
  const lastKeyRef = useRef<string | null>(null);
  if (liveKey !== null) lastKeyRef.current = liveKey;
  const key = liveKey ?? lastKeyRef.current;

  // Refs for callbacks that need the latest chain/client without re-subscribing
  const chainRef = useRef(chain);
  chainRef.current = chain;
  const clientRef = useRef(client);
  clientRef.current = client;
  const keyRef = useRef(key);
  keyRef.current = key;

  // subscribe and getSnapshot must depend on `key` so useSyncExternalStore
  // re-subscribes when the cache key changes (e.g. null -> real key after auth).
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!key) return () => {};
      const e = getOrCreate(key);
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

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Fetch on key change. Uses the ref to get the latest chain.
  useEffect(() => {
    if (!key) return;
    const currentChain = chainRef.current;
    if (!currentChain) return;

    const entry = getOrCreate(key);
    // Reset retry state when key changes (new query)
    entry.retryCount = 0;
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }

    if (entry.items === EMPTY && !entry.loading) {
      // Entry was created but never fetched (or was reset)
      doFetch(key, entry, currentChain, clientRef.current);
    } else if (
      entry.items === EMPTY &&
      entry.error === null &&
      !entry.dispose
    ) {
      // Fresh entry — needs initial fetch
      doFetch(key, entry, currentChain, clientRef.current);
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch on reconnect
  useEffect(() => {
    const onReconnect = () => {
      const k = keyRef.current;
      const currentChain = chainRef.current;
      if (!k || !currentChain) return;
      const entry = cache.get(k);
      if (!entry) return;
      // Reset retry state and refetch
      entry.retryCount = 0;
      if (entry.retryTimer) {
        clearTimeout(entry.retryTimer);
        entry.retryTimer = null;
      }
      doFetch(k, entry, currentChain, clientRef.current);
    };

    client.on("connected", onReconnect);
    return () => {
      client.off("connected", onReconnect);
    };
  }, [client]);

  const refetch = useCallback(() => {
    const k = keyRef.current;
    const currentChain = chainRef.current;
    if (!k || !currentChain) return;
    const entry = getOrCreate(k);
    entry.retryCount = 0; // Manual refetch resets retry
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
      // Use Model.create() so the instance is marked as new (SYM_IS_NEW)
      // and will POST on save() instead of PUT.
      instance = ModelClass.create(item);
    } else {
      instance = item;
    }

    // Ensure tmp is set for reconciliation
    if (!instance.tmp) {
      instance.tmp = generateId();
    }

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

  // Must be before early return to maintain hook order.
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

  if (!key)
    return {
      items: EMPTY as T[],
      loading: !authReady,
      error: null,
      total: 0,
      refetch: noop,
      addOptimistic: noopAdd,
      removeOptimistic: noop,
      onOps,
    };

  const entry = cache.get(key);
  const serverItems = entry?.items ?? (EMPTY as T[]);
  const optimisticItems = entry?.optimistic ?? [];

  // Merge server + optimistic, deduplicating by id or tmp (server wins).
  const items: T[] =
    optimisticItems.length > 0
      ? ([...serverItems, ...optimisticItems].reduce(
          (acc: any[], item: any) => {
            if (
              !acc.some(
                (a: any) => a.id === item.id || (a.tmp && a.tmp === item.tmp),
              )
            )
              acc.push(item);
            return acc;
          },
          [],
        ) as T[])
      : (serverItems as T[]);

  return {
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

// ─── @internal — test-only access to the cache ───────────────────────────────
//
// Exposed so unit tests can exercise the disconnect/reconnect path,
// retry scheduling, and applyOps without going through React render.
// Not part of the public surface — the names are deliberately prefixed
// with `__` so consumers know they're framework-internal.

/** @internal */
export const __test = {
  /** Clear the module-level cache between tests. */
  resetCache(): void {
    for (const entry of cache.values()) {
      entry.dispose?.();
      if (entry.gcTimer) clearTimeout(entry.gcTimer);
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
    }
    cache.clear();
  },

  /** Read the current entry (or undefined). */
  getEntry(key: string): CacheEntry | undefined {
    return cache.get(key);
  },

  /** Construct a cache key the same way `useQuery` does. */
  buildKey(modelType: string, userId: string | null, steps: unknown[]): string {
    return `${modelType}:${userId ?? "anon"}:${JSON.stringify(steps)}`;
  },

  /** Trigger the same fetch the hook would on first mount. */
  fetch(
    key: string,
    chain: QueryChain<any>,
    client: ParcaeClient,
  ): CacheEntry {
    const entry = getOrCreate(key);
    doFetch(key, entry, chain, client);
    return entry;
  },

  /** Hand-add a subscriber to keep the entry alive (refs counter). */
  retain(key: string, onChange: () => void): () => void {
    const entry = getOrCreate(key);
    entry.refs++;
    entry.listeners.add(onChange);
    return () => {
      entry.listeners.delete(onChange);
      entry.refs--;
    };
  },
}
