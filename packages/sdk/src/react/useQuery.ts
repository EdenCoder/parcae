"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { applyPatch, type Operation } from "fast-json-patch";
import { Model } from "@parcae/model";
import { useParcae } from "./context";
import { useAuthStatus } from "./useAuth";
import { log } from "../log";

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
}

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  items: any[];
  loading: boolean;
  error: Error | null;
  /**
   * Hash that changes when the consumer should re-render.
   * Encodes: loading flag, error presence, and item id list.
   * Property-level changes on individual items flow through valtio
   * proxies and do NOT need a re-render at the list level.
   */
  hash: string;
  refs: number;
  listeners: Set<() => void>;
  dispose: (() => void) | null;
  gcTimer: ReturnType<typeof setTimeout> | null;
  queryHash: string | null;
}

const cache = new Map<string, CacheEntry>();
const GC_DELAY = 60_000;
const EMPTY: any[] = [];
const INITIAL_HASH = "L"; // loading=true, no items

/**
 * Build a hash that captures the "shape" of the entry — loading state,
 * error state, and which items are in the list (by id + order).
 * Property-level mutations on existing items don't change this hash;
 * those flow reactively through valtio proxies on each Model instance.
 */
function buildHash(e: CacheEntry): string {
  if (e.loading) return "L";
  if (e.error) return `E:${e.error.message}`;
  // id list preserves order — a reorder or add/remove changes the hash
  let h = "D:";
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
      loading: true,
      error: null,
      hash: INITIAL_HASH,
      refs: 0,
      listeners: new Set(),
      dispose: null,
      gcTimer: null,
      queryHash: null,
    };
    cache.set(key, e);
  }
  return e;
}

/**
 * Recompute the hash and notify listeners only if it changed.
 * This means useSyncExternalStore triggers a re-render only when:
 *   - loading/error state transitions
 *   - items are added, removed, or reordered
 * It does NOT re-render for property-level changes on existing items
 * (those propagate through valtio's proxy on each Model instance).
 */
function notify(e: CacheEntry): void {
  const next = buildHash(e);
  if (next !== e.hash) {
    e.hash = next;
    for (const fn of e.listeners) fn();
  }
}

/**
 * Force-notify — always fires listeners regardless of hash.
 * Used after the initial fetch completes so the snapshot transitions
 * from EMPTY to the real items array even if the hash happens to match
 * (e.g. both are "D:" for an empty result set).
 */
function forceNotify(e: CacheEntry): void {
  e.hash = buildHash(e);
  for (const fn of e.listeners) fn();
}

// ── Ops application ──────────────────────────────────────────────────────────

type QueryOp =
  | { op: "add"; id: string; data: Record<string, any> }
  | { op: "remove"; id: string }
  | { op: "update"; id: string; patch: Operation[] };

/**
 * Apply surgical ops from the subscription manager to the cached items.
 * Update ops carry JSON Patch (RFC 6902) diffs — only the changed fields
 * are sent over the wire, not the entire document.
 * Mutates nothing — returns a new array.
 */
function applyOps(
  items: any[],
  ops: QueryOp[],
  modelClass: any,
  adapter: any,
): any[] {
  // Index current items by id for fast lookup
  const byId = new Map<string, any>();
  for (const item of items) byId.set(item.id, item);

  for (const op of ops) {
    switch (op.op) {
      case "add":
        if (op.data && !byId.has(op.id)) {
          const instance = new modelClass(adapter, op.data);
          byId.set(op.id, instance);
        }
        break;
      case "update": {
        const existing = byId.get(op.id);
        if (existing && op.patch) {
          const rawData = JSON.parse(
            JSON.stringify(existing.__data ?? existing),
          );
          applyPatch(rawData, op.patch);
          byId.set(op.id, new modelClass(adapter, rawData));
        }
        break;
      }
      case "remove":
        byId.delete(op.id);
        break;
    }
  }

  return [...byId.values()];
}

/**
 * Resolve the adapter for subscription ops.
 * Lazy queries have __adapter = null, so fall back to the global adapter.
 */
function resolveAdapter(chain: QueryChain<any>): any {
  return chain.__adapter ?? (Model.hasAdapter() ? Model.getAdapter() : null);
}

// ── Fetch + subscribe ────────────────────────────────────────────────────────

function doFetch(
  key: string,
  entry: CacheEntry,
  chain: QueryChain<any>,
  client: any,
): void {
  log.debug("useQuery: fetching", chain.__modelType);
  entry.loading = true;
  entry.error = null;
  notify(entry);

  chain
    .find()
    .then((result: any[]) => {
      log.debug("useQuery: got", result.length, "items for", chain.__modelType);
      entry.items = result;
      entry.loading = false;

      // Pick up the query subscription hash from the backend response
      const hash = (result as any).__queryHash;
      if (hash && hash !== entry.queryHash) {
        // Unsubscribe from previous hash if any
        entry.dispose?.();
        entry.queryHash = hash;

        const adapter = resolveAdapter(chain);

        // Subscribe to query-level ops
        const unsub = client.subscribe(`query:${hash}`, (ops: QueryOp[]) => {
          if (!Array.isArray(ops) || ops.length === 0) return;
          entry.items = applyOps(entry.items, ops, chain.__modelClass, adapter);
          notify(entry);
        });
        entry.dispose = unsub;
      }

      // Force-notify so the snapshot transitions from EMPTY to real items,
      // even if the hash matches (e.g. loading -> 0 items: both hash to "D:")
      forceNotify(entry);
    })
    .catch((err: Error) => {
      log.error("useQuery: error", err.message);
      entry.error = err;
      entry.loading = false;
      forceNotify(entry);
    });
}

// ── useQuery ─────────────────────────────────────────────────────────────────

export function useQuery<T>(
  chain: QueryChain<T> | null | undefined,
  options: UseQueryOptions = {},
): UseQueryResult<T> {
  const client = useParcae();
  const waitForAuth = options.waitForAuth ?? true;
  const { status: authStatus, version: authVersion } = useAuthStatus();
  const authReady = !waitForAuth || authStatus !== "pending";

  const key =
    chain && authReady
      ? `${chain.__modelType}:${authVersion}:${JSON.stringify(chain.__steps ?? [])}`
      : null;

  const keyRef = useRef(key);
  keyRef.current = key;

  const subscribe = (onChange: () => void) => {
    const k = keyRef.current;
    if (!k) return () => {};
    const e = getOrCreate(k);
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
        e.gcTimer = setTimeout(() => {
          e.dispose?.();
          cache.delete(k);
        }, GC_DELAY);
      }
    };
  };

  const getSnapshot = (): string => {
    const k = keyRef.current;
    if (!k) return INITIAL_HASH;
    return cache.get(k)?.hash ?? INITIAL_HASH;
  };

  // useSyncExternalStore compares the hash string by value.
  // Re-renders only when loading/error state or item list composition changes.
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!key || !chain) return;
    const entry = getOrCreate(key);
    if (entry.items === EMPTY) {
      doFetch(key, entry, chain, client);
    }

    return () => {
      // Cleanup is handled by the subscribe() unsub above + GC timer
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const refetch = () => {
    if (!key || !chain) return;
    doFetch(key, getOrCreate(key), chain, client);
  };

  if (!key)
    return {
      items: EMPTY as T[],
      loading: !authReady,
      error: null,
      refetch: () => {},
    };

  const entry = cache.get(key);
  return {
    items: entry?.items ?? (EMPTY as T[]),
    loading: entry?.loading ?? true,
    error: entry?.error ?? null,
    refetch,
  };
}
