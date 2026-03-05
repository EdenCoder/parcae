"use client";

/**
 * useQuery — reactive data fetching with realtime subscriptions.
 *
 * Takes a query chain, returns an array of typed model instances.
 * Subscribes to realtime updates — the server diffs queries on model changes
 * and pushes surgical add/remove/update ops.
 *
 * @example
 * ```tsx
 * const { items, loading } = useQuery(Post.where({ published: true }));
 * ```
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useParcae } from "./context";

// ─── Types ───────────────────────────────────────────────────────────────────

interface QueryChain<T> {
  find(): Promise<T[]>;
  __steps?: any[];
  __modelType?: string;
  __modelClass?: any;
  __adapter?: any;
  __debounceMs?: number;
}

interface UseQueryResult<T> {
  items: T[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

interface DiffOp {
  op: "add" | "remove" | "update";
  id: string;
  data?: Record<string, any>;
}

// ─── Query Cache ─────────────────────────────────────────────────────────────

const CACHE_TIMEOUT_MS = 60_000;
const DEFAULT_DEBOUNCE_MS = 100;

interface CacheEntry<T = any> {
  items: T[];
  itemMap: Map<string, T>;
  loading: boolean;
  error: Error | null;
  refCount: number;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  version: number;
  stateVersion: number;
  listeners: Set<() => void>;
  subscriptionHash: string | null;
  pendingOps: DiffOp[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  debounceMs: number;
  disposeSubscription: (() => void) | null;
}

const queryCache = new Map<string, CacheEntry>();

function buildCacheKey(chain: QueryChain<any>, authVersion: number): string {
  const type = chain.__modelType ?? "unknown";
  const steps = JSON.stringify(chain.__steps ?? []);
  return `${type}:${authVersion}:${steps}`;
}

// ─── useQuery ────────────────────────────────────────────────────────────────

export function useQuery<T>(
  chain: QueryChain<T> | null | undefined,
): UseQueryResult<T> {
  const client = useParcae();
  const authVersion = client.authVersion;

  const cacheKey = chain ? buildCacheKey(chain, authVersion) : "__null__";

  // ── Get or create cache entry ──────────────────────────────────────

  if (!queryCache.has(cacheKey) && chain) {
    queryCache.set(cacheKey, {
      items: [],
      itemMap: new Map(),
      loading: true,
      error: null,
      refCount: 0,
      timeoutHandle: null,
      version: 0,
      stateVersion: 0,
      listeners: new Set(),
      subscriptionHash: null,
      pendingOps: [],
      debounceTimer: null,
      debounceMs: chain.__debounceMs ?? DEFAULT_DEBOUNCE_MS,
      disposeSubscription: null,
    });
  }

  const entry = queryCache.get(cacheKey);

  // ── useSyncExternalStore for tear-safe rendering ───────────────────

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!entry) return () => {};
      entry.listeners.add(listener);
      entry.refCount++;

      // Cancel pending GC
      if (entry.timeoutHandle) {
        clearTimeout(entry.timeoutHandle);
        entry.timeoutHandle = null;
      }

      return () => {
        entry.listeners.delete(listener);
        entry.refCount--;

        // GC: if no subscribers left, schedule cleanup
        if (entry.refCount <= 0) {
          entry.timeoutHandle = setTimeout(() => {
            entry.disposeSubscription?.();
            queryCache.delete(cacheKey);
          }, CACHE_TIMEOUT_MS);
        }
      };
    },
    [entry, cacheKey],
  );

  const getSnapshot = useCallback(() => entry?.stateVersion ?? 0, [entry]);

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // ── Fetch + subscribe ──────────────────────────────────────────────

  const refetch = useCallback(() => {
    if (!chain || !entry) return;

    entry.loading = true;
    notifyListeners(entry);

    chain
      .find()
      .then((items) => {
        entry.items = items;
        entry.itemMap = new Map(items.map((item: any) => [item.id, item]));
        entry.loading = false;
        entry.error = null;
        entry.version++;
        notifyListeners(entry);
      })
      .catch((err) => {
        entry.error = err;
        entry.loading = false;
        notifyListeners(entry);
      });

    // Set up realtime subscription if transport supports it
    if (!entry.disposeSubscription && chain.__modelType) {
      const subEvent = `query:${cacheKey}`;

      // Ask server to subscribe to this query
      client.send("subscribe:query", {
        hash: cacheKey,
        modelType: chain.__modelType,
        steps: chain.__steps ?? [],
      });

      // Listen for diff ops from the server
      const dispose = client.subscribe(subEvent, (ops: DiffOp[]) => {
        if (!entry) return;
        entry.pendingOps.push(...ops);

        // Debounce application of ops
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
        entry.debounceTimer = setTimeout(() => {
          applyDiffOps(entry, chain);
          entry.debounceTimer = null;
        }, entry.debounceMs);
      });

      entry.subscriptionHash = cacheKey;
      entry.disposeSubscription = () => {
        dispose();
        client.send("unsubscribe:query", { hash: cacheKey });
      };
    }
  }, [chain, entry, cacheKey, client]);

  // Initial fetch on mount / chain change
  useEffect(() => {
    if (chain) refetch();
  }, [cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!entry) {
    return { items: [], loading: false, error: null, refetch: () => {} };
  }

  return {
    items: entry.items,
    loading: entry.loading,
    error: entry.error,
    refetch,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function notifyListeners(entry: CacheEntry): void {
  entry.stateVersion++;
  for (const listener of entry.listeners) listener();
}

function applyDiffOps<T>(entry: CacheEntry<T>, chain: QueryChain<T>): void {
  const ops = entry.pendingOps.splice(0);
  if (!ops.length) return;

  const ModelClass = chain.__modelClass;
  const adapter = chain.__adapter;
  let changed = false;

  for (const op of ops) {
    switch (op.op) {
      case "add": {
        if (!entry.itemMap.has(op.id) && op.data && ModelClass && adapter) {
          const instance = new ModelClass(adapter, op.data);
          entry.items.push(instance);
          entry.itemMap.set(op.id, instance);
          changed = true;
        }
        break;
      }
      case "remove": {
        if (entry.itemMap.has(op.id)) {
          entry.items = entry.items.filter((item: any) => item.id !== op.id);
          entry.itemMap.delete(op.id);
          changed = true;
        }
        break;
      }
      case "update": {
        const existing = entry.itemMap.get(op.id) as any;
        if (existing && op.data) {
          for (const [key, value] of Object.entries(op.data)) {
            existing.__data[key] = value;
          }
          changed = true;
        }
        break;
      }
    }
  }

  if (changed) {
    entry.version++;
    notifyListeners(entry);
  }
}
