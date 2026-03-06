"use client";

/**
 * useQuery — efficient reactive data fetching.
 *
 * - Deduplicates: same query from multiple components = one fetch
 * - Caches: unmount/remount doesn't re-fetch if data is fresh
 * - Realtime: subscribes to server-pushed diffs (add/remove/update)
 * - Auth-aware: waits for auth before firing scoped queries
 * - Efficient: React only re-renders when the items array reference changes
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useParcae } from "./context";
import type { ParcaeClient } from "../client";

// ─── Types ───────────────────────────────────────────────────────────────────

interface QueryChain<T> {
  find(): Promise<T[]>;
  __steps?: any[];
  __modelType?: string;
  __modelClass?: any;
  __adapter?: any;
}

interface UseQueryOptions {
  /** Wait for auth before firing. Default: true. */
  waitForAuth?: boolean;
}

interface UseQueryResult<T> {
  items: T[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

// ─── External Cache ──────────────────────────────────────────────────────────

interface CacheEntry {
  items: any[];
  loading: boolean;
  error: Error | null;
  refs: number;
  listeners: Set<() => void>;
  dispose: (() => void) | null;
  gcTimer: ReturnType<typeof setTimeout> | null;
}

const cache = new Map<string, CacheEntry>();
const GC_DELAY = 60_000;

const EMPTY: any[] = [];
const EMPTY_RESULT: UseQueryResult<any> = {
  items: EMPTY,
  loading: true,
  error: null,
  refetch: () => {},
};

function getOrCreate(key: string): CacheEntry {
  let entry = cache.get(key);
  if (!entry) {
    entry = {
      items: EMPTY,
      loading: true,
      error: null,
      refs: 0,
      listeners: new Set(),
      dispose: null,
      gcTimer: null,
    };
    cache.set(key, entry);
  }
  return entry;
}

function notify(entry: CacheEntry): void {
  for (const fn of entry.listeners) fn();
}

// ─── Fetch + Subscribe ───────────────────────────────────────────────────────

function fetchAndSubscribe(
  key: string,
  entry: CacheEntry,
  chain: QueryChain<any>,
  client: ParcaeClient,
): void {
  // Fetch
  entry.loading = true;
  entry.error = null;
  notify(entry);

  chain
    .find()
    .then((result: any[]) => {
      entry.items = result;
      entry.loading = false;
      notify(entry);
    })
    .catch((err: Error) => {
      entry.error = err;
      entry.loading = false;
      notify(entry);
    });

  // Subscribe to realtime diffs
  if (!entry.dispose && chain.__modelType) {
    const event = `query:${key}`;

    client.send("subscribe:query", {
      hash: key,
      modelType: chain.__modelType,
      steps: chain.__steps ?? [],
    });

    const unsub = client.subscribe(event, (ops: any[]) => {
      if (!ops?.length) return;

      const map = new Map(entry.items.map((item: any) => [item.id, item]));
      let changed = false;

      for (const op of ops) {
        switch (op.op) {
          case "add":
            if (!map.has(op.id) && op.data && chain.__modelClass) {
              map.set(op.id, new chain.__modelClass(chain.__adapter, op.data));
              changed = true;
            }
            break;
          case "remove":
            if (map.has(op.id)) {
              map.delete(op.id);
              changed = true;
            }
            break;
          case "update": {
            const existing = map.get(op.id);
            if (existing && op.data) {
              for (const [k, v] of Object.entries(op.data)) {
                (existing as any)[k] = v;
              }
              changed = true;
            }
            break;
          }
        }
      }

      if (changed) {
        entry.items = [...map.values()];
        notify(entry);
      }
    });

    entry.dispose = () => {
      unsub();
      client.send("unsubscribe:query", { hash: key });
      entry.dispose = null;
    };
  }
}

// ─── useQuery ────────────────────────────────────────────────────────────────

export function useQuery<T>(
  chain: QueryChain<T> | null | undefined,
  options: UseQueryOptions = {},
): UseQueryResult<T> {
  const { client, authState, authVersion } = useParcae();
  const waitForAuth = options.waitForAuth ?? true;
  const authReady = !waitForAuth || authState !== "loading";

  const key =
    chain && authReady
      ? `${chain.__modelType}:${authVersion}:${JSON.stringify(chain.__steps ?? [])}`
      : null;

  // Ref to track the current key (for cleanup)
  const keyRef = useRef(key);
  keyRef.current = key;

  // ── useSyncExternalStore ──────────────────────────────────────────

  const subscribe = (onStoreChange: () => void) => {
    const k = keyRef.current;
    if (!k) return () => {};

    const entry = getOrCreate(k);
    entry.refs++;
    entry.listeners.add(onStoreChange);

    // Cancel GC
    if (entry.gcTimer) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = null;
    }

    return () => {
      entry.listeners.delete(onStoreChange);
      entry.refs--;

      if (entry.refs <= 0) {
        entry.gcTimer = setTimeout(() => {
          entry.dispose?.();
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

  // ── Trigger fetch when key changes ────────────────────────────────

  useEffect(() => {
    if (!key || !chain) return;

    const entry = getOrCreate(key);

    // Only fetch if this is the first subscriber or items are empty
    if (entry.items === EMPTY || entry.items.length === 0) {
      fetchAndSubscribe(key, entry, chain, client);
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Refetch ───────────────────────────────────────────────────────

  const refetch = () => {
    if (!key || !chain) return;
    const entry = getOrCreate(key);
    fetchAndSubscribe(key, entry, chain, client);
  };

  // ── Return ────────────────────────────────────────────────────────

  if (!key) return EMPTY_RESULT;

  const entry = cache.get(key);
  return {
    items,
    loading: entry?.loading ?? true,
    error: entry?.error ?? null,
    refetch,
  };
}
