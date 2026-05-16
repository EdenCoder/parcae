import { log } from "../logger";
/**
 * QuerySubscriptionManager — server-side realtime query subscriptions.
 *
 * Clients subscribe to queries. On model changes, queries are re-evaluated,
 * diffed against cached results, and surgical add/remove/update ops are
 * emitted to subscribers.
 *
 * Update ops carry RFC 6902 JSON Patch arrays — only the changed fields are
 * sent over the wire, not the entire document.
 *
 * The emitted envelope is `{ ops, order? }`:
 *   - `ops` — `add` / `remove` / `update` ops (existing contract).
 *   - `order` — the new ordered id list, included whenever membership
 *     changed or the previous order differs from the new order. Lets
 *     ordered queries (`.orderBy(...)`) place freshly-added rows in
 *     the right slot client-side rather than appending to the end.
 *
 * Re-eval is debounced per-query — bursts of writes (e.g. a job
 * patching every block in a project) collapse into one re-eval per
 * `debounceMs` window, with a `maxWaitMs` ceiling so changes never
 * stall on a sustained write loop. Per-Model overrides via
 * `static realtime = { debounceMs, maxWaitMs }` on the Model class.
 *
 * Extracted from Dollhouse Studio's adapters/subscriptions.ts (308 lines).
 */

import { createHash } from "node:crypto";
import type { QueryChain } from "@parcae/model";
import fastJsonPatch from "fast-json-patch";
import type { Operation } from "fast-json-patch";

// ─── Types ───────────────────────────────────────────────────────────────────

type DiffOp =
  | { op: "add"; id: string; data: Record<string, any> }
  | { op: "remove"; id: string }
  | { op: "update"; id: string; patch: Operation[] };

/** Wire envelope sent on `query:{hash}`. */
export interface QueryEmitEnvelope {
  ops: DiffOp[];
  /** Ordered id list, present whenever membership/order changed. */
  order?: string[];
}

interface CachedQuery {
  hash: string;
  modelType: string;
  query: QueryChain<any>;
  /**
   * Iteration order of this Map IS the order rows came back from the
   * DB on the last re-eval (and therefore matches the orderBy spec
   * the query was built with). The client-side `applyOps` uses the
   * `order` field on the envelope to reorder; this map is the
   * server-side source of truth for that ordering.
   */
  result: Map<string, Record<string, any>>;
  subscribers: Set<string>;
  /** Coalescing state, lazily initialised on first onModelChange. */
  coalesce: {
    /** Trailing debounce — reset on each onModelChange. */
    debounceTimer: ReturnType<typeof setTimeout> | null;
    /** Max-wait ceiling — armed on first incoming change, never reset. */
    maxWaitTimer: ReturnType<typeof setTimeout> | null;
    /** Re-eval in flight. Follow-up changes set a `needsFollowup` flag. */
    inFlight: boolean;
    needsFollowup: boolean;
    /** Override window from `Model.realtime` or manager default. */
    debounceMs: number;
    maxWaitMs: number;
  };
}

interface SubscriptionOptions {
  socketId: string;
  query: QueryChain<any>;
}

interface SubscribeExtraOptions {
  /**
   * Force the cached result to be rebuilt from the database. Used by
   * the client drift-poll path so an `__forceRefresh: true` request
   * reconciles any cache drift (e.g. a missed cross-process event)
   * for the polling client AND every other subscriber on the same
   * hash in a single re-eval cycle.
   */
  force?: boolean;
}

interface ManagerOptions {
  /** Default trailing-debounce window for re-eval, in ms. Default 25ms. */
  debounceMs?: number;
  /** Default max-wait ceiling for re-eval, in ms. Default 100ms. */
  maxWaitMs?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashFrom(toSQL: { sql: string; bindings: any[] }): string {
  const payload = JSON.stringify({ sql: toSQL.sql, bindings: toSQL.bindings });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** JSON round-trip to normalize Dates to strings, strip undefined, etc. */
function jsonClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function isUpdatedAtPath(path: string): boolean {
  const segments = path.split("/");
  return segments[segments.length - 1] === "updatedAt";
}

function stripVolatilePatchOps(patch: Operation[]): Operation[] {
  return patch.filter((op) => !isUpdatedAtPath(op.path));
}

/**
 * Read per-Model realtime tuning. Models can declare:
 *   ```ts
 *   class Asset extends Model {
 *     static realtime = { debounceMs: 250, maxWaitMs: 1000 };
 *   }
 *   ```
 *  to coalesce writes more aggressively on hot tables.
 */
function realtimeOverridesFor(query: QueryChain<any>): {
  debounceMs?: number;
  maxWaitMs?: number;
} {
  const modelClass = query.__modelClass as
    | { realtime?: { debounceMs?: number; maxWaitMs?: number } }
    | undefined;
  const realtime = modelClass?.realtime;
  if (!realtime || typeof realtime !== "object") return {};
  const out: { debounceMs?: number; maxWaitMs?: number } = {};
  if (typeof realtime.debounceMs === "number") out.debounceMs = realtime.debounceMs;
  if (typeof realtime.maxWaitMs === "number") out.maxWaitMs = realtime.maxWaitMs;
  return out;
}

function ordersEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ─── Manager ─────────────────────────────────────────────────────────────────

/**
 * Per-socket subscription cap. Without it, a misbehaving client can
 * subscribe to N distinct queries — each cached server-side with its
 * own row set + per-model-change re-eval cost — and exhaust the
 * server. 100 is well above typical UI usage (each page mounts a
 * handful of `useQuery`s) and well below the threshold where a
 * single socket starts to materially impact server memory.
 *
 * Hitting the cap is a development-time mistake or an attack, not a
 * legitimate runtime case — log loudly and silently drop the new
 * subscription's items (the client gets an empty result for that
 * query, consistent with how an unsubscribed query reads).
 */
const MAX_SUBSCRIPTIONS_PER_SOCKET = 100;

const DEFAULT_DEBOUNCE_MS = 25;
const DEFAULT_MAX_WAIT_MS = 100;

export class QuerySubscriptionManager {
  private queries = new Map<string, CachedQuery>();
  private socketQueries = new Map<string, Set<string>>();
  private typeIndex = new Map<string, Set<string>>();

  private emitToSocket: (socketId: string, event: string, data: any) => void;
  private defaultDebounceMs: number;
  private defaultMaxWaitMs: number;

  constructor(
    emitToSocket: (socketId: string, event: string, data: any) => void,
    opts: ManagerOptions = {},
  ) {
    this.emitToSocket = emitToSocket;
    this.defaultDebounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.defaultMaxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  // ── Subscribe ──────────────────────────────────────────────────────

  async subscribe(
    opts: SubscriptionOptions,
    extra: SubscribeExtraOptions = {},
  ): Promise<{ hash: string; items: Record<string, any>[] }> {
    const { socketId, query } = opts;
    // `__modelType` lives on the QueryChain interface as @internal —
    // populated by every chain factory (`Model._query` → `lazyQuery`
    // server-side, the adapter's `query()` factory client-side).
    const modelType = query.__modelType;
    const hash = hashFrom(query.exec().toSQL());

    // Per-socket cap enforced BEFORE the cache lookup so a socket
    // can't unlock new subscriptions by re-requesting an already-
    // cached hash. The cap is on the socket's distinct-hash set
    // size, not on the cached query's total subscribers — sharing a
    // query across many sockets is fine and intentional.
    const existing = this.socketQueries.get(socketId);
    const alreadySubscribed = existing?.has(hash) ?? false;
    if (
      !alreadySubscribed &&
      (existing?.size ?? 0) >= MAX_SUBSCRIPTIONS_PER_SOCKET
    ) {
      log.warn(
        `subscriptions: socket ${socketId} hit the ${MAX_SUBSCRIPTIONS_PER_SOCKET} subscription cap — refusing new query for ${modelType}`,
      );
      return { hash, items: [] };
    }

    let cached = this.queries.get(hash);

    if (cached) {
      cached.subscribers.add(socketId);
      // Drift-poll path: caller asked us to re-execute the cached
      // query against the DB and diff to every subscriber. We run
      // _reeval inline so the LIST response that follows returns
      // the freshly-rebuilt items and the polling client converges
      // in one round-trip. Other subscribers receive any drift ops
      // through the normal `query:{hash}` channel.
      if (extra.force) {
        await this._reeval(cached);
      }
    } else {
      const rows = await this._execQuery(query);
      const result = new Map<string, Record<string, any>>();
      for (const row of rows) {
        const clean = jsonClone(row);
        result.set(clean.id, clean);
      }

      const overrides = realtimeOverridesFor(query);
      cached = {
        hash,
        modelType,
        query,
        result,
        subscribers: new Set([socketId]),
        coalesce: {
          debounceTimer: null,
          maxWaitTimer: null,
          inFlight: false,
          needsFollowup: false,
          debounceMs: overrides.debounceMs ?? this.defaultDebounceMs,
          maxWaitMs: overrides.maxWaitMs ?? this.defaultMaxWaitMs,
        },
      };
      this.queries.set(hash, cached);

      if (!this.typeIndex.has(modelType)) {
        this.typeIndex.set(modelType, new Set());
      }
      this.typeIndex.get(modelType)!.add(hash);
    }

    if (!this.socketQueries.has(socketId)) {
      this.socketQueries.set(socketId, new Set());
    }
    this.socketQueries.get(socketId)!.add(hash);

    return { hash, items: [...cached.result.values()] };
  }

  // ── Unsubscribe ────────────────────────────────────────────────────

  unsubscribe(socketId: string, hash: string): void {
    const cached = this.queries.get(hash);
    if (!cached) return;

    cached.subscribers.delete(socketId);
    this.socketQueries.get(socketId)?.delete(hash);

    if (cached.subscribers.size === 0) {
      this._teardownCoalesce(cached);
      this.queries.delete(hash);
      this.typeIndex.get(cached.modelType)?.delete(hash);
    }
  }

  unsubscribeAll(socketId: string): void {
    const hashes = this.socketQueries.get(socketId);
    if (!hashes) return;

    for (const hash of hashes) {
      const cached = this.queries.get(hash);
      if (!cached) continue;
      cached.subscribers.delete(socketId);
      if (cached.subscribers.size === 0) {
        this._teardownCoalesce(cached);
        this.queries.delete(hash);
        this.typeIndex.get(cached.modelType)?.delete(hash);
      }
    }

    this.socketQueries.delete(socketId);
  }

  // ── On Model Change ────────────────────────────────────────────────

  /**
   * A model of `modelType` was written somewhere. Schedule a debounced
   * re-eval for every cached query watching this type.
   *
   * Same-tick bursts collapse into one re-eval (debounce reset). A
   * sustained stream of changes still produces re-eval cycles at
   * `maxWaitMs` intervals — clients never stall behind a write loop.
   */
  onModelChange(modelType: string): void {
    const hashes = this.typeIndex.get(modelType);
    if (!hashes || hashes.size === 0) return;

    for (const hash of hashes) {
      const cached = this.queries.get(hash);
      if (!cached) continue;
      this._scheduleReeval(cached);
    }
  }

  // ── Re-evaluation ──────────────────────────────────────────────────

  private _scheduleReeval(cached: CachedQuery): void {
    const c = cached.coalesce;

    // While a re-eval is in flight, just mark a follow-up so we run
    // again on the next tick once it lands. Don't queue parallel runs.
    if (c.inFlight) {
      c.needsFollowup = true;
      return;
    }

    // Fast-path: both windows at 0 → fire synchronously. Used by
    // tests that want predictable behaviour, and by call sites that
    // turn coalescing off via `Model.realtime`.
    if (c.debounceMs <= 0 && c.maxWaitMs <= 0) {
      void this._runReeval(cached);
      return;
    }

    // Reset the trailing debounce on every signal. Whichever timer
    // fires first wins; both get cleared at that point.
    if (c.debounceTimer) clearTimeout(c.debounceTimer);
    c.debounceTimer = setTimeout(() => {
      void this._runReeval(cached);
    }, c.debounceMs);

    // Max-wait fires regardless. Only armed on the first signal of
    // the current window so a steady stream of writes can't push it
    // back indefinitely.
    if (!c.maxWaitTimer) {
      c.maxWaitTimer = setTimeout(() => {
        void this._runReeval(cached);
      }, c.maxWaitMs);
    }
  }

  private async _runReeval(cached: CachedQuery): Promise<void> {
    const c = cached.coalesce;
    if (c.debounceTimer) {
      clearTimeout(c.debounceTimer);
      c.debounceTimer = null;
    }
    if (c.maxWaitTimer) {
      clearTimeout(c.maxWaitTimer);
      c.maxWaitTimer = null;
    }

    c.inFlight = true;
    c.needsFollowup = false;
    try {
      await this._reeval(cached);
    } catch (err) {
      log.error(`subscriptions: re-eval failed for ${cached.hash}:`, err);
    } finally {
      c.inFlight = false;
    }
    if (c.needsFollowup) {
      // A change arrived mid-re-eval. Schedule a follow-up so we
      // converge against the latest world state.
      this._scheduleReeval(cached);
    }
  }

  private _teardownCoalesce(cached: CachedQuery): void {
    const c = cached.coalesce;
    if (c.debounceTimer) {
      clearTimeout(c.debounceTimer);
      c.debounceTimer = null;
    }
    if (c.maxWaitTimer) {
      clearTimeout(c.maxWaitTimer);
      c.maxWaitTimer = null;
    }
    c.needsFollowup = false;
  }

  private async _reeval(cached: CachedQuery): Promise<void> {
    if (cached.subscribers.size === 0) return;

    const rows = await this._execQuery(cached.query);
    const newResult = new Map<string, Record<string, any>>();
    for (const row of rows) {
      const clean = jsonClone(row);
      newResult.set(clean.id, clean);
    }

    const ops: DiffOp[] = [];

    for (const [id, data] of newResult) {
      const prev = cached.result.get(id);
      if (!prev) {
        ops.push({ op: "add", id, data });
      } else {
        const patch = stripVolatilePatchOps(fastJsonPatch.compare(prev, data));
        if (patch.length > 0) {
          ops.push({ op: "update", id, patch });
        }
      }
    }

    for (const id of cached.result.keys()) {
      if (!newResult.has(id)) ops.push({ op: "remove", id });
    }

    // Compute the order envelope BEFORE we swap the cached result so
    // we can compare prev order to new order. Always include `order`
    // when membership changed (any add/remove) OR when the ordering
    // of surviving ids differs. Stable updates with stable order skip
    // it so we don't waste bytes.
    const prevOrder = [...cached.result.keys()];
    const newOrder = [...newResult.keys()];
    const hasMembershipChange = ops.some(
      (o) => o.op === "add" || o.op === "remove",
    );
    const orderChanged = !ordersEqual(prevOrder, newOrder);
    const includeOrder = hasMembershipChange || orderChanged;

    cached.result = newResult;

    if (ops.length === 0 && !includeOrder) return;

    const envelope: QueryEmitEnvelope = includeOrder
      ? { ops, order: newOrder }
      : { ops };

    for (const socketId of cached.subscribers) {
      this.emitToSocket(socketId, `query:${cached.hash}`, envelope);
    }
  }

  // ── Query Execution ────────────────────────────────────────────────

  private async _execQuery(
    query: QueryChain<any>,
  ): Promise<Record<string, any>[]> {
    const models = await query.clone().find();
    // `query.find()` returns `Promise<any[]>` (the chain's generic is
    // `any`); the projection runs `sanitize()` for every Model row
    // and falls back to `__data` for any non-Model row that snuck
    // through (defensive — the default `sanitize` is now on Model
    // itself, so the fallback is effectively unreachable for real
    // model classes).
    return Promise.all(
      models.map((m: any) => m.sanitize?.() ?? m.__data ?? m),
    );
  }

  // ── Stats ──────────────────────────────────────────────────────────

  get stats() {
    let totalSubscribers = 0;
    for (const cached of this.queries.values())
      totalSubscribers += cached.subscribers.size;
    return {
      queries: this.queries.size,
      subscribers: totalSubscribers,
      sockets: this.socketQueries.size,
    };
  }
}
