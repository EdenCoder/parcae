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
  /**
   * Returns a sibling chain whose `.find()` sends
   * `__forceRefresh: true`. Used by the drift poll to bypass the
   * server-side subscription cache.
   */
  withForceRefresh?: () => QueryChain<T>;
}

interface UseQueryOptions {
  waitForAuth?: boolean;
  /**
   * Periodic drift-detection refetch interval, in milliseconds.
   * The poll fetches the LIST endpoint with `__forceRefresh: true`,
   * which makes the server re-execute the underlying query against
   * the database, rebuild its subscription cache, and emit any
   * drift ops to every subscriber. Drift detected on the client is
   * logged with the prefix `[useQuery DOL-894]` for diagnostics.
   *
   * Set to `0` to disable. Polling automatically pauses while the
   * tab is hidden and while the transport is disconnected.
   *
   * Default `60_000`.
   */
  poll?: number;
}

interface UseQueryResult<T> {
  items: T[];
  /**
   * `true` while no items have been delivered yet AND the consumer
   * should display some kind of placeholder. This covers BOTH the
   * "auth still resolving" and "wire request in flight" phases —
   * which is the historical contract — but blurs them. Use
   * `awaitingAuth` to distinguish if you want phase-specific UX.
   */
  loading: boolean;
  /**
   * `true` while `useQuery` is parked because the auth gate hasn't
   * resolved yet (and `waitForAuth` is on, which is the default).
   * The hook hasn't even attempted a wire request — the cache key
   * is `null` because `userId` isn't known.
   *
   * Recommended UX split:
   *
   *   - `awaitingAuth: true` → "Signing you in…"
   *   - `loading: true && !awaitingAuth` → real fetch in flight,
   *      show a data skeleton.
   *   - `loading: false` → items are populated (possibly empty).
   *
   * Always `false` when `waitForAuth: false` was passed — anonymous
   * queries fire immediately and skip the auth gate.
   */
  awaitingAuth: boolean;
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

/**
 * Drop every cache entry whose key was generated for a different
 * user than `currentUserId`. Used on auth transitions
 * (sign-out → `null`; user switch → new userId) to evict stale
 * entries that belonged to the previous session BEFORE the 60s GC
 * timer would otherwise reach them.
 *
 * Cache keys are `${modelType}:${userId ?? "anon"}:${JSON.stringify(steps)}`,
 * so the prior-user segment is exactly `:${prevUserId}:`. We don't
 * touch entries for the current user or for explicitly-anonymous
 * (`:anon:`) chains, since those belong to ongoing consumers.
 */
function purgeCacheForUser(prevUserId: string | null): void {
  if (prevUserId === null) return;
  const needle = `:${prevUserId}:`;
  for (const [key, entry] of cache) {
    if (!key.includes(needle)) continue;
    entry.dispose?.();
    if (entry.gcTimer) clearTimeout(entry.gcTimer);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    cache.delete(key);
  }
}

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

/**
 * Wire envelope emitted by `QuerySubscriptionManager`. Older servers
 * may emit a bare `QueryOp[]`; we accept both shapes in
 * `normalizeOpsPayload` below.
 */
interface QueryEnvelope {
  ops: QueryOp[];
  /** New ordered id list — present whenever membership/order changed. */
  order?: string[];
}

/** Result from applyOps indicating what changed */
interface ApplyResult {
  items: any[];
  /** Whether any items were mutated in-place or membership changed */
  changed: boolean;
}

function normalizeOpsPayload(
  raw: unknown,
): { ops: QueryOp[]; order?: string[] } | null {
  if (Array.isArray(raw)) return { ops: raw as QueryOp[] };
  if (
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as any).ops)
  ) {
    const envelope = raw as QueryEnvelope;
    return envelope.order
      ? { ops: envelope.ops, order: envelope.order }
      : { ops: envelope.ops };
  }
  return null;
}

/**
 * Reorder an items array to match the new ordered id list. Returns
 * `null` when no reordering was needed (items already in the same
 * order as `order`) so callers can skip a redundant array rebuild.
 */
function reorderByIds<T extends { id: string }>(
  items: T[],
  order: string[],
): T[] | null {
  if (items.length === 0) return null;
  // Fast-path: if items already match the desired order one-to-one,
  // skip the rebuild. Callers can short-circuit re-render.
  if (items.length === order.length) {
    let same = true;
    for (let i = 0; i < items.length; i++) {
      if (items[i]?.id !== order[i]) {
        same = false;
        break;
      }
    }
    if (same) return null;
  }
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  const next: T[] = [];
  for (const id of order) {
    const found = byId.get(id);
    if (found) next.push(found);
  }
  // If the order array doesn't reference every item (e.g. older server,
  // partial order spec), append the unmatched items in their original
  // order to avoid silently dropping them.
  if (next.length !== items.length) {
    const placed = new Set(order);
    for (const item of items) {
      if (!placed.has(item.id)) next.push(item);
    }
  }
  return next;
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

// ── Drift detection helpers ──────────────────────────────────────────────────

interface DriftSnapshot {
  ids: string[];
  updatedAtById: Map<string, string | undefined>;
}

function snapshotItems(items: any[]): DriftSnapshot {
  const ids: string[] = new Array(items.length);
  const updatedAtById = new Map<string, string | undefined>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const id = item?.id as string | undefined;
    if (!id) continue;
    ids[i] = id;
    const ua = item?.updatedAt;
    updatedAtById.set(
      id,
      ua instanceof Date ? ua.toISOString() : ua ? String(ua) : undefined,
    );
  }
  return { ids, updatedAtById };
}

function reportDriftIfAny(
  prev: DriftSnapshot,
  next: any[],
  modelType: string | undefined,
): void {
  const nextIds = new Set<string>();
  let updatedAtDrift = 0;
  let modifiedIds = 0;
  for (const item of next) {
    const id = item?.id as string | undefined;
    if (!id) continue;
    nextIds.add(id);
    if (!prev.updatedAtById.has(id)) {
      modifiedIds++;
      continue;
    }
    const prevUa = prev.updatedAtById.get(id);
    const nextUaRaw = item?.updatedAt;
    const nextUa =
      nextUaRaw instanceof Date
        ? nextUaRaw.toISOString()
        : nextUaRaw
          ? String(nextUaRaw)
          : undefined;
    if (prevUa !== nextUa) updatedAtDrift++;
  }
  let removedIds = 0;
  for (const id of prev.ids) {
    if (!id) continue;
    if (!nextIds.has(id)) removedIds++;
  }
  const drifted = updatedAtDrift + modifiedIds + removedIds;
  if (drifted > 0) {
    log.warn(
      `[useQuery DOL-894] drift detected modelType=${modelType ?? "unknown"} added=${modifiedIds} removed=${removedIds} updated=${updatedAtDrift}`,
    );
  }
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
  opts: { force?: boolean } = {},
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

  // For the drift-poll path: redirect through a sibling chain that
  // sends `__forceRefresh: true`. The server re-executes the cached
  // subscription query against the DB, rebuilds its result map, and
  // emits drift ops via the normal `query:{hash}` channel — so even
  // sockets that aren't polling converge once we land. Snapshot the
  // current items first so we can detect drift on this client too.
  const prevSnapshot = opts.force ? snapshotItems(entry.items) : null;
  const fetchChain =
    opts.force && typeof chain.withForceRefresh === "function"
      ? chain.withForceRefresh()
      : chain;

  fetchChain
    .find()
    .then((result: any[]) => {
      log.debug("useQuery: got", result.length, "items for", chain.__modelType);
      const hash = (result as any).__queryHash;
      if (prevSnapshot) {
        // Drift detection — log only. The new data will overwrite
        // the cache below; this is purely diagnostic so we can
        // quantify cross-process event-loss in the wild before
        // tightening defaults.
        reportDriftIfAny(prevSnapshot, result, chain.__modelType);
      }
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
      if (hash && hash !== entry.queryHash) {
        entry.dispose?.();
        entry.queryHash = hash;

        const adapter = resolveAdapter(chain);

        const unsub = client.subscribe(`query:${hash}`, (payload: unknown) => {
          const parsed = normalizeOpsPayload(payload);
          if (!parsed) return;
          const { ops, order } = parsed;
          // No ops and no order → bail. (An empty envelope can occur
          // when the order envelope alone arrived for a server that
          // never reaches this branch in practice, but we guard.)
          if (ops.length === 0 && !order) return;
          const result = applyOps(
            entry.items,
            ops,
            chain.__modelClass,
            adapter,
            entry,
          );
          let items = result.items;
          let changed = result.changed;
          if (order) {
            const reordered = reorderByIds(items, order);
            if (reordered) {
              items = reordered;
              changed = true;
            }
          }
          if (!changed) return;
          entry.items = items;
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
  // Strict gate (DOL-894): with `waitForAuth: true` (default), only
  // fire requests once the user is *actually* authenticated. The
  // previous check `authStatus !== "pending"` let the
  // "unauthenticated" state through, which produced 403s on every
  // mounted query before a sign-in finished. Queries that
  // legitimately want to read anonymously must opt out via
  // `waitForAuth: false`.
  const authReady = !waitForAuth || authStatus === "authenticated";

  // Compute the "live" key when auth is ready.
  const liveKey =
    chain && authReady
      ? `${chain.__modelType}:${userId ?? "anon"}:${JSON.stringify(chain.__steps ?? [])}`
      : null;

  // Hold on to the last valid key so we keep showing stale data during
  // disconnects (when auth temporarily resets to "pending"). When auth
  // is *explicitly* `unauthenticated`, drop the fallback — handing
  // back rows from a previous session would leak data across the
  // sign-out boundary AND drive the fetch effects to re-issue
  // forbidden requests against `userId: "anon"`.
  const lastKeyRef = useRef<string | null>(null);
  if (authStatus === "unauthenticated") lastKeyRef.current = null;
  if (liveKey !== null) lastKeyRef.current = liveKey;
  const key = liveKey ?? lastKeyRef.current;

  // Refs for callbacks that need the latest chain/client without re-subscribing
  const chainRef = useRef(chain);
  chainRef.current = chain;
  const clientRef = useRef(client);
  clientRef.current = client;
  const keyRef = useRef(key);
  keyRef.current = key;
  // Ref so async fetch callbacks (reconnect, poll) can re-check the
  // current auth state at the moment they'd otherwise hit the wire,
  // not the state at effect-mount time. Without this, a transient
  // reconnect during a sign-out window fires a forbidden request.
  const authReadyRef = useRef(authReady);
  authReadyRef.current = authReady;

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

    // Single-source-of-truth for "should we kick a fetch off?":
    // `entry.chain` is set on the very first line of `doFetch` (before
    // any await), so its absence is the canonical "no fetch has ever
    // started for this key" signal. A combined check like
    // `items === EMPTY && !loading && !dispose` would let a SECOND
    // hook landing on the same key fire `doFetch` while the first
    // fetch is still in flight — `dispose` is only set AFTER the
    // fetch resolves and the subscription opens, so the second hook
    // would slip through and run a redundant cache update +
    // notify cascade. Gating on `entry.chain` closes that.
    if (!entry.chain) {
      doFetch(key, entry, currentChain, clientRef.current);
    } else if (entry.items === EMPTY && !entry.loading && !entry.error) {
      // Entry exists but was somehow reset (chain set, loading false,
      // items still EMPTY sentinel, no error). Edge case — kick a
      // fresh fetch.
      doFetch(key, entry, currentChain, clientRef.current);
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch when auth transitions INTO "authenticated".
  //
  // The socket-level `"connected"` event used to drive this, but it
  // fires before the AuthGate's `authenticate` handshake completes —
  // so gating on `authReady` at that moment always bailed, and
  // nothing else triggered the refetch once auth eventually
  // resolved. After a reconnect the server's subscription manager
  // has no record of this socket (it disposed everything on the
  // previous socket-id's `disconnect`), so a missed refetch =
  // permanently silent realtime updates.
  //
  // Driving from authStatus directly fixes both:
  //   - On initial mount, `authReady` flips false → true and the
  //     `useEffect([key])` above handles first fetch. We skip here
  //     when `entry.queryHash` is unset so we don't double-fire.
  //   - On reconnect, authStatus cycles `authenticated` →
  //     `pending` → `authenticated`. The transition into the final
  //     `authenticated` state is exactly when we want to refire,
  //     re-establishing the server-side subscription (it was
  //     wiped when the prior socket-id disconnected).
  //   - For users who never authenticate (anonymous), this never
  //     fires — no 403 storm.
  const prevAuthStatusRef = useRef<typeof authStatus | null>(null);
  useEffect(() => {
    const prev = prevAuthStatusRef.current;
    prevAuthStatusRef.current = authStatus;

    if (prev === null) return;
    if (authStatus !== "authenticated") return;
    if (prev === "authenticated") return;

    const k = keyRef.current;
    const currentChain = chainRef.current;
    if (!k || !currentChain) return;
    const entry = cache.get(k);
    if (!entry) return;
    // First-time fetches are handled by the `[key]` effect. Only
    // re-fire when a prior subscription existed — that's the
    // server-side state we need to re-establish after the socket
    // disconnect wiped it.
    if (!entry.queryHash) return;

    entry.retryCount = 0;
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    doFetch(k, entry, currentChain, clientRef.current);
  }, [authStatus]);

  // ── Drift poll ─────────────────────────────────────────────────────
  //
  // Periodic refetch with `__forceRefresh: true` so the server
  // re-executes the cached subscription query and emits any drift
  // ops to every subscriber on the hash. Pauses while the tab is
  // hidden or the transport is disconnected — both states are
  // covered by other code paths (visibilitychange → no UI to update;
  // reconnect → forced refetch via `onReconnect`). Gated on
  // `options.poll`; default `60_000`, `0` disables.
  const pollMs = options.poll ?? 60_000;
  useEffect(() => {
    if (!key) return;
    if (pollMs <= 0) return;
    if (typeof setInterval !== "function") return;

    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      const k = keyRef.current;
      const currentChain = chainRef.current;
      if (!k || !currentChain) return;
      // Mirror the reconnect gate: a poll firing during a sign-out
      // or token-refresh window would race ahead of auth and 403.
      // `authReadyRef` reflects the latest auth state regardless of
      // when this effect was last mounted.
      if (!authReadyRef.current) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      if (clientRef.current.isConnected === false) return;
      const entry = cache.get(k);
      if (!entry) return;
      if (entry.refs <= 0) return;
      doFetch(k, entry, currentChain, clientRef.current, { force: true });
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(tick, pollMs);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    start();

    const onVisibility = () => {
      if (stopped) return;
      if (typeof document === "undefined") return;
      if (document.visibilityState === "visible") {
        // Resume — fire one fresh tick immediately so the user sees a
        // converged view as soon as they return to the tab, instead
        // of waiting up to `pollMs` for the next interval.
        tick();
        start();
      } else {
        stop();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      stopped = true;
      stop();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [key, pollMs]);

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

  // `awaitingAuth` reflects "we're parked on the auth gate" — only
  // true when the consumer asked us to wait (default) AND the gate
  // is still in flight. Distinct from `loading` (which also covers
  // wire-in-flight). See `UseQueryResult.awaitingAuth` JSDoc.
  const awaitingAuth = waitForAuth && authStatus === "pending";

  if (!key)
    return {
      items: EMPTY as T[],
      loading: !authReady,
      awaitingAuth,
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
    awaitingAuth,
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

// ─── prefetch ────────────────────────────────────────────────────────────────

/**
 * Options for `prefetch(client, chain, options?)`.
 */
export interface PrefetchOptions {
  /**
   * Wait for the auth gate to resolve before building the cache key
   * and firing the request. Default `true`.
   *
   * Critical for auth safety: without this gate, a prefetch called
   * during the "pending" window would build a key with `userId ??
   * "anon"` (i.e. literally `:anon:`), then the wire request would
   * pause on `auth.ready` and ultimately fire with the resolved
   * user's cookie. The authenticated response would land in a cache
   * entry KEYED AS ANONYMOUS — visible to any subsequent
   * `useQuery({ waitForAuth: false })` looking up the same chain.
   *
   * With `waitForAuth: true` (default), we don't build the key until
   * the gate resolves, so the entry is keyed under the actual user.
   *
   * Set to `false` only for legitimately-public queries.
   */
  waitForAuth?: boolean;
}

/**
 * Prime the `useQuery` cache so a later component mount finds items
 * already loaded — skipping the `mount → commit → useEffect → fetch`
 * cascade.
 *
 * Typical usage: a route loader, a parent component effect, or the
 * `ParcaeProvider`'s `onReady` callback warms the cache for known
 * routes before the leaf components mount.
 *
 *   await client.prefetch(Project.where({ id: params.id }).limit(1));
 *
 * The returned Promise resolves with the loaded items (or rejects
 * on error). Subscriptions open automatically — the cache entry
 * stays live so the eventual `useQuery` consumer joins an existing
 * subscription.
 *
 * Returns the existing cache entry's items if the same key was
 * primed earlier (or is currently in flight) — no duplicate work.
 *
 * Auth-safe by default. See `PrefetchOptions.waitForAuth` for the
 * `:anon:` key pollution threat model.
 */
export async function prefetch<T>(
  client: ParcaeClient,
  chain: QueryChain<T>,
  options: PrefetchOptions = {},
): Promise<T[]> {
  const waitForAuth = options.waitForAuth ?? true;
  const auth = (client.transport as any)?.auth as
    | { ready: Promise<void>; state: { userId: string | null } }
    | undefined;

  // Critical for auth safety — see `PrefetchOptions.waitForAuth`.
  // We build the key AFTER the gate resolves so the entry is keyed
  // by the actual userId, not by `:anon:`.
  if (waitForAuth && auth) {
    await auth.ready;
  }

  const userId = auth?.state?.userId ?? null;
  const modelType = (chain as any).__modelType;
  if (!modelType) {
    throw new Error(
      "prefetch: chain has no __modelType — was it built from a real Model class?",
    );
  }
  const steps = (chain as any).__steps ?? [];
  const key = `${modelType}:${userId ?? "anon"}:${JSON.stringify(steps)}`;

  const entry = getOrCreate(key);

  // Retain the entry while we're waiting so the 60s GC doesn't fire
  // mid-flight. Released when the Promise settles.
  entry.refs++;
  if (entry.gcTimer) {
    clearTimeout(entry.gcTimer);
    entry.gcTimer = null;
  }

  return new Promise<T[]>((resolve, reject) => {
    let settled = false;

    const release = () => {
      entry.refs--;
      if (entry.refs <= 0) {
        // Same GC delay useQuery uses — gives a window for a
        // consumer to mount and pick up the primed entry without
        // re-fetching.
        entry.gcTimer = setTimeout(() => {
          entry.dispose?.();
          cache.delete(key);
        }, GC_DELAY);
      }
    };

    const settle = (value: T[] | Error) => {
      if (settled) return;
      settled = true;
      entry.listeners.delete(onChange);
      release();
      if (value instanceof Error) reject(value);
      else resolve(value);
    };

    const onChange = () => {
      if (entry.error) settle(entry.error);
      else if (!entry.loading) settle(entry.items as T[]);
    };

    // Already errored? Surface synchronously.
    if (entry.error) {
      settle(entry.error);
      return;
    }
    // Already loaded? Items may be `[]` (loaded-but-empty) — that
    // still counts as "done". `entry.queryHash !== null` distinguishes
    // "loaded into an empty result" from "fresh entry, never fetched".
    if (!entry.loading && entry.queryHash !== null) {
      settle(entry.items as T[]);
      return;
    }

    // Either in flight (a parallel prefetch or a mounted useQuery is
    // already fetching) or fresh. Subscribe for the completion notify.
    entry.listeners.add(onChange);

    // Kick off the fetch if nothing has yet — `entry.chain` is set
    // by `doFetch` so its absence is the canonical "never fetched"
    // signal. Avoids re-firing when a useQuery already started one.
    if (!entry.chain) {
      doFetch(key, entry, chain as any, client);
    }
  });
}

/** @internal — exposed so the auth gate can drive evictions. */
export function _purgeCacheForUser(prevUserId: string | null): void {
  purgeCacheForUser(prevUserId);
}

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
