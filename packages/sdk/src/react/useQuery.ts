"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { applyPatch, type Operation } from "fast-json-patch";
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
  refs: number;
  listeners: Set<() => void>;
  dispose: (() => void) | null;
  gcTimer: ReturnType<typeof setTimeout> | null;
  queryHash: string | null;
}

const cache = new Map<string, CacheEntry>();
const GC_DELAY = 60_000;
const EMPTY: any[] = [];

function getOrCreate(key: string): CacheEntry {
  let e = cache.get(key);
  if (!e) {
    e = {
      items: EMPTY,
      loading: true,
      error: null,
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

function notify(e: CacheEntry): void {
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
          // Both `patch` values and `__data` values should be plain JSON
          // (no Dates etc, because they crossed the wire) so applyPatch
          // doesn't stumble on objects treating them like iterables.
          // We clone deeply first so we don't mutate the old instance's __data.
          const rawData = JSON.parse(
            JSON.stringify(existing.__data ?? existing),
          );
          // applyPatch mutates the object we pass it
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

        // Subscribe to query-level ops
        const unsub = client.subscribe(`query:${hash}`, (ops: QueryOp[]) => {
          if (!Array.isArray(ops) || ops.length === 0) return;
          entry.items = applyOps(
            entry.items,
            ops,
            chain.__modelClass,
            chain.__adapter,
          );
          notify(entry);
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

  const getSnapshot = (): any[] => {
    const k = keyRef.current;
    if (!k) return EMPTY;
    return cache.get(k)?.items ?? EMPTY;
  };

  const items = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  ) as T[];

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
    items,
    loading: entry?.loading ?? true,
    error: entry?.error ?? null,
    refetch,
  };
}
