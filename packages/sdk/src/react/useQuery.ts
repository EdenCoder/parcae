"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
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
    };
    cache.set(key, e);
  }
  return e;
}

function notify(e: CacheEntry): void {
  for (const fn of e.listeners) fn();
}

function doFetch(key: string, entry: CacheEntry, chain: QueryChain<any>): void {
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
      doFetch(key, entry, chain);
    }

    // Subscribe to model-level change events → refetch
    if (chain.__modelType) {
      const unsub = client.subscribe(`model:${chain.__modelType}:changed`, () =>
        doFetch(key, getOrCreate(key), chain),
      );
      return unsub;
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const refetch = () => {
    if (!key || !chain) return;
    doFetch(key, getOrCreate(key), chain);
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
