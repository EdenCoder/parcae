"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { type Operation } from "fast-json-patch";
import { Model, SYM_SERVER_MERGE } from "@parcae/model";
import { useParcae } from "./context";
import { useAuthStatus } from "./useAuth";
import { log } from "../log";
import type { ParcaeClient } from "../client";

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
  hash: string;
  version: number;
  refs: number;
  listeners: Set<() => void>;
  dispose: (() => void) | null;
  gcTimer: ReturnType<typeof setTimeout> | null;
  queryHash: string | null;
  /** The chain used for the last fetch — stored so retry/refetch don't need a closure. */
  chain: QueryChain<any> | null;
  /** The client used for the last fetch. */
  client: ParcaeClient | null;
  /** Retry state */
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
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
      version: 0,
      refs: 0,
      listeners: new Set(),
      dispose: null,
      gcTimer: null,
      queryHash: null,
      chain: null,
      client: null,
      retryCount: 0,
      retryTimer: null,
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

/**
 * Convert RFC 6902 JSON Patch operations into a flat key→value map.
 * Only handles "replace" and "add" ops with top-level paths (e.g. "/name").
 * Nested paths are applied to a shallow clone of the current top-level value.
 */
function patchToData(
  patches: Operation[],
  current: Record<string, any>,
): Record<string, any> {
  const data: Record<string, any> = {};

  for (const op of patches) {
    if (op.op !== "replace" && op.op !== "add") continue;
    const segments = op.path.split("/").filter(Boolean);
    if (segments.length === 0) continue;

    const topKey = segments[0]!;
    if (segments.length === 1) {
      // Top-level property — direct assignment
      data[topKey] = (op as any).value;
    } else {
      // Nested path — build/merge into the top-level object
      if (!(topKey in data)) {
        // Start from a shallow clone of the current value so we don't
        // lose sibling keys that aren't in this patch batch.
        const cur = current[topKey];
        data[topKey] =
          cur != null && typeof cur === "object"
            ? Array.isArray(cur) ? [...cur] : { ...cur }
            : {};
      }
      let cursor: any = data[topKey];
      for (let i = 1; i < segments.length - 1; i++) {
        const seg = segments[i]!;
        if (cursor[seg] == null) cursor[seg] = {};
        cursor = cursor[seg];
      }
      cursor[segments[segments.length - 1]!] = (op as any).value;
    }
  }

  return data;
}

function applyOps(
  items: any[],
  ops: QueryOp[],
  modelClass: any,
  adapter: any,
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

  const hasRemoves = removeIds.size > 0;
  const hasAdds = addOps.size > 0;
  let hasRelevantUpdates = false;

  // Apply updates in-place — mutate existing instances atomically,
  // preserving any pending local changes via SYM_SERVER_MERGE.
  for (const [id, patches] of updateOps) {
    const existing = byId.get(id);
    if (!existing) continue;
    hasRelevantUpdates = true;

    const currentData = existing.__data ?? {};
    const merged = patchToData(patches, currentData);
    const serverMerge = existing[SYM_SERVER_MERGE];
    if (serverMerge) {
      serverMerge(merged);
    } else {
      // Fallback: write through the proxy (shouldn't happen for Model instances)
      for (const [k, v] of Object.entries(merged)) {
        existing[k] = v;
      }
    }
  }

  // If only updates (no membership changes), return the same array reference
  // but signal that data was mutated in-place.
  if (!hasRemoves && !hasAdds) {
    return { items, changed: hasRelevantUpdates };
  }

  // Membership changed — build a new array, reusing existing instances
  const result: any[] = [];

  for (const item of items) {
    if (!removeIds.has(item.id)) result.push(item);
  }

  for (const [id, data] of addOps) {
    if (!byId.has(id)) {
      result.push(new modelClass(adapter, data));
    }
  }

  return { items: result, changed: true };
}

/**
 * Reconcile a fresh fetch result with the previous items array.
 * For items that exist in both, merges server data into the existing instance
 * in-place (via SYM_SERVER_MERGE) so local pending changes are preserved.
 * Only creates new instances for items not previously present.
 */
function reconcile(prev: any[], next: any[]): any[] {
  if (prev === EMPTY || prev.length === 0) return next;

  const prevById = new Map<string, any>();
  for (const item of prev) prevById.set(item.id, item);

  let membershipChanged = prev.length !== next.length;
  const result: any[] = new Array(next.length);

  for (let i = 0; i < next.length; i++) {
    const fresh = next[i];
    const existing = prevById.get(fresh.id);
    if (existing) {
      // Merge server data in-place, respecting local pending changes
      const serverMerge = existing[SYM_SERVER_MERGE];
      if (serverMerge) {
        const freshData = fresh.__data ?? fresh;
        serverMerge(freshData);
      }
      result[i] = existing;
      if (!membershipChanged && prev[i]?.id !== fresh.id) membershipChanged = true;
    } else {
      result[i] = fresh;
      membershipChanged = true;
    }
  }

  // If same items in same order, return the original array reference
  return membershipChanged ? result : prev;
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

  const delay = RETRY_DELAYS[Math.min(entry.retryCount, RETRY_DELAYS.length - 1)]!;
  log.debug(`useQuery: scheduling retry ${entry.retryCount + 1}/${MAX_RETRIES} in ${delay}ms`);

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
      entry.items = reconcile(entry.items, result);
      entry.loading = false;
      entry.retryCount = 0; // Reset retries on success
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
          if (!Array.isArray(ops) || ops.length === 0) return;
          const result = applyOps(entry.items, ops, chain.__modelClass, adapter);
          if (!result.changed) return;
          entry.items = result.items;
          entry.version++;
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
  const authReady = !waitForAuth || authStatus !== "pending";

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
  const subscribe = useCallback((onChange: () => void) => {
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
  }, [key]);

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
    } else if (entry.items === EMPTY && entry.error === null && !entry.dispose) {
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
