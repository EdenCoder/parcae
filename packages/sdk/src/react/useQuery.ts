"use client";

/**
 * useQuery — reactive data fetching with realtime subscriptions.
 *
 * @example
 * ```tsx
 * const { items, loading } = useQuery(Post.where({ published: true }));
 *
 * // Wait for auth before firing (default: true)
 * const { items } = useQuery(query, { waitForAuth: true });
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

interface UseQueryOptions {
  /**
   * Wait for authentication to resolve before firing the query.
   * Default: true — queries don't fire while auth is "loading".
   * Set to false for public/unauthenticated queries.
   */
  waitForAuth?: boolean;
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
  options: UseQueryOptions = {},
): UseQueryResult<T> {
  const { client, authState, authVersion } = useParcae();
  const waitForAuth = options.waitForAuth ?? true;

  // If waiting for auth and auth is still loading, return empty loading state
  const authReady = !waitForAuth || authState !== "loading";

  const cacheKey =
    chain && authReady ? buildCacheKey(chain, authVersion) : "__null__";

  // ── Get or create cache entry ──────────────────────────────────────

  if (!queryCache.has(cacheKey) && chain && authReady) {
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

      if (entry.timeoutHandle) {
        clearTimeout(entry.timeoutHandle);
        entry.timeoutHandle = null;
      }

      return () => {
        entry.listeners.delete(listener);
        entry.refCount--;

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
    if (!chain || !entry || !authReady) return;

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

    // Set up realtime subscription
    if (!entry.disposeSubscription && chain.__modelType) {
      const subEvent = `query:${cacheKey}`;

      client.send("subscribe:query", {
        hash: cacheKey,
        modelType: chain.__modelType,
        steps: chain.__steps ?? [],
      });

      const dispose = client.subscribe(subEvent, (ops: DiffOp[]) => {
        if (!entry) return;
        entry.pendingOps.push(...ops);

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
  }, [chain, entry, cacheKey, client, authReady]);

  // Fetch when auth becomes ready or cache key changes
  useEffect(() => {
    if (chain && authReady) refetch();
  }, [cacheKey, authReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auth not ready — return loading
  if (!authReady) {
    return { items: [], loading: true, error: null, refetch: () => {} };
  }

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
            existing[key] = value;
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
