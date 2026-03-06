"use client";

/**
 * useQuery — calls chain.find() via socket RPC, subscribes to diffs automatically.
 *
 * No separate subscribe:query event. The server auto-subscribes when you
 * query a list endpoint. Diffs arrive on the same query key.
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

// ─── Fetch via chain.find() ──────────────────────────────────────────────────

function doFetch(
  key: string,
  entry: CacheEntry,
  chain: QueryChain<any>,
  client: ParcaeClient,
): void {
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

  // Listen for realtime diffs (server auto-subscribes on the call)
  if (!entry.dispose && chain.__modelType) {
    const diffEvent = `query:diff:${key}`;

    const unsub = client.subscribe(diffEvent, (ops: any[]) => {
      if (!ops?.length) return;

      const map = new Map(entry.items.map((i: any) => [i.id, i]));
      let changed = false;

      for (const op of ops) {
        if (
          op.op === "add" &&
          !map.has(op.id) &&
          op.data &&
          chain.__modelClass
        ) {
          map.set(op.id, new chain.__modelClass(chain.__adapter, op.data));
          changed = true;
        } else if (op.op === "remove" && map.has(op.id)) {
          map.delete(op.id);
          changed = true;
        } else if (op.op === "update" && map.has(op.id) && op.data) {
          const existing = map.get(op.id);
          for (const [k, v] of Object.entries(op.data))
            (existing as any)[k] = v;
          changed = true;
        }
      }

      if (changed) {
        entry.items = [...map.values()];
        notify(entry);
      }
    });

    entry.dispose = () => {
      unsub();
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
