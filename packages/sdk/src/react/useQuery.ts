"use client";

/**
 * useQuery — reactive data fetching. Auth state from Valtio snapshot.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useSnapshot } from "valtio";
import { log } from "../log";
import { useParcae } from "./context";
import type { ParcaeClient } from "../client";
import type { AuthState } from "../auth-gate";

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

// ── External Cache ───────────────────────────────────────────────────────────

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
  log.info("useQuery: fetching", chain.__modelType, "key:", key.slice(0, 40));
  entry.loading = true;
  entry.error = null;
  notify(entry);

  chain
    .find()
    .then((result: any[]) => {
      log.info("useQuery: got", result.length, "items for", chain.__modelType);
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

function getAuthGate(client: ParcaeClient): AuthState | null {
  const transport = client.transport as any;
  return transport?.auth?.state ?? null;
}

export function useQuery<T>(
  chain: QueryChain<T> | null | undefined,
  options: UseQueryOptions = {},
): UseQueryResult<T> {
  const client = useParcae();
  const waitForAuth = options.waitForAuth ?? true;

  // Read auth state reactively via Valtio snapshot
  const authGate = getAuthGate(client);
  const authSnap = authGate ? useSnapshot(authGate as any) : null;
  const authStatus = (authSnap as any)?.status ?? "pending";
  const authVersion = (authSnap as any)?.version ?? 0;
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
