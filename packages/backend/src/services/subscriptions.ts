import { dateSafeClone } from "@parcae/model";
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
import {
  orderEmissionDisabled,
  type QueryChain,
  type QueryStep,
} from "@parcae/model";
import fastJsonPatch from "fast-json-patch";
import type { Operation } from "fast-json-patch";
import { RefLoader } from "./ref-loader";
import {
  hydrateExpansions,
  type ResolvedExpand,
} from "./hydrate-expansions";

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
   * Per-query ref expansions recorded by `.expand(...)`. Drives the
   * per-emit `hydrateExpansions` pass that inlines linked rows in
   * the cached result. Empty when the subscriber didn't ask for any
   * expansions — identical to the no-expand emit path.
   */
  expand: readonly ResolvedExpand[];
  /**
   * Iteration order of this Map IS the order rows came back from the
   * DB on the last re-eval (and therefore matches the orderBy spec
   * the query was built with). The client-side `applyOps` uses the
   * `order` field on the envelope to reorder; this map is the
   * server-side source of truth for that ordering.
   */
  result: Map<string, Record<string, any>>;
  subscribers: Set<string>;
  /**
   * Whether to emit the `order` field on the wire envelope. `false`
   * when the query carries `.orderBy(false)` — consumers don't
   * care about the ordered id list and we save bytes + spare the
    * client a `reorderByIds` pass.
   *
   * Always `true` for the first subscriber's `subscribe()` call; if
   * a later subscriber for the same hash opts out, we honour the
   * opt-out (one false poisons the channel). In practice the hash
   * is derived from the SQL the query produces, so two distinct
   * subscriptions with different `orderBy(false)` choices would
   * share a hash only if their other steps and SQL are identical
   * — and in that case the false-leaning preference is what every
   * caller actually wants.
   */
  emitOrder: boolean;
  /** Coalescing state, lazily initialised on first onModelChange. */
  coalesce: {
    /** Trailing debounce — reset on each onModelChange. */
    debounceTimer: ReturnType<typeof setTimeout> | null;
    /** Max-wait ceiling — armed on first incoming change, never reset. */
    maxWaitTimer: ReturnType<typeof setTimeout> | null;
    /**
     * The re-eval currently in flight, `null` when idle. Follow-up
     * changes set `needsFollowup`; the force path awaits it so a
     * drift poll can't race a debounced re-eval on the same query.
     */
    inFlight: Promise<void> | null;
    needsFollowup: boolean;
    /** Override window from `Model.realtime` or manager default. */
    debounceMs: number;
    maxWaitMs: number;
  };
}

interface SubscriptionOptions {
  socketId: string;
  query: QueryChain<any>;
  /**
   * Per-query ref expansions recorded by `.expand(...)` on the
   * client. Subscriptions with different expand projections live as
   * distinct cached queries (the hash includes the projection key
   * via `expandHashKey`) so emits ship the right shape per
   * consumer. Empty → no expansions.
   */
  expand?: readonly ResolvedExpand[];
  /**
   * Raw client-sent steps. Used to detect `.orderBy(false)` so the
   * subscriptions manager skips order envelope emission for queries
   * whose consumers don't care about ordering.
   *
   * `undefined` means "use the default" (emit order whenever it
   * changes). Pass the original step list from `prepareClientQuery`
   * to honour an `orderBy(false)` opt-out.
   */
  steps?: QueryStep[];
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
  /**
   * Maximum concurrent `_reeval` operations across all cached queries.
   * Default 8. See `Semaphore` JSDoc for the rationale — a write-storm
   * on a hot table can schedule N distinct cached-query re-evals at
   * the same instant; without a cap, every one of them hits the DB
   * pool in parallel.
   *
   * Overridable at boot via the `PARCAE_REEVAL_CONCURRENCY` env var
   * (parsed by `createApp()` and passed in via this option).
   */
  reevalConcurrency?: number;
  /**
   * Per-socket distinct-subscription cap. See the
   * `DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET` JSDoc below for the
   * rationale; the default (500) is sized to cover heavy SPA
   * navigation (every visited page leaves its useQuery subscriptions
   * warm for ~60s via the SDK's GC delay, so a user clicking through
   * ~50 detail pages with ~10 queries each in under a minute stays
   * under the cap). Apps with much heavier subscription footprints
   * can bump it higher; the cap is per-socket so the cost is bounded
   * by `(cap × concurrent sockets)`.
   *
   * Overridable at boot via the `PARCAE_MAX_SUBSCRIPTIONS_PER_SOCKET`
   * env var (parsed by `createApp()` and passed in via this option).
   */
  maxSubscriptionsPerSocket?: number;
}

/**
 * Socket.IO backend hooks. The legacy form passes just `emitToSocket`
 * and the manager fans out re-eval envelopes via a per-subscriber
 * loop (one `io.to(socketId).emit(...)` per subscriber, N for N
 * subscribers).
 *
 * The room-aware form also supplies `emitToRoom`,
 * `joinRoom`, and `leaveRoom`. Every subscriber for a given cached
 * query joins the Socket.IO room `query:${hash}` at subscribe-time,
 * so re-eval can broadcast ONCE via `io.to(room).emit(...)` regardless
 * of how many sockets are listening. Substantial savings at scale
 * (100 subscribers per query: 100 emits → 1).
 */
type EmitToSocket = (socketId: string, event: string, data: any) => void;
type EmitToRoom = (room: string, event: string, data: any) => void;
type JoinRoom = (socketId: string, room: string) => void;
type LeaveRoom = (socketId: string, room: string) => void;

interface IoBackend {
  emitToSocket: EmitToSocket;
  /** Optional room broadcast. When present, used in place of per-socket emits. */
  emitToRoom?: EmitToRoom;
  joinRoom?: JoinRoom;
  leaveRoom?: LeaveRoom;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashFrom(
  toSQL: { sql: string; bindings: any[] },
  expand: readonly ResolvedExpand[],
): string {
  // Expand projections are part of the cache key: a `.find()` with
  // and without `.expand("file")` returns different wire shapes and
  // must NOT share a cached subscription. Per-ref projection lists
  // are sorted so callers that vary argument order still collapse.
  const expandKey =
    expand.length === 0
      ? ""
      : expand
          .map((e) => {
            if (!e.projection) return e.refField;
            const fields = Array.from(e.projection).sort();
            return `${e.refField}.{${fields.join(",")}}`;
          })
          .sort()
          .join("|");
  const payload = JSON.stringify({
    sql: toSQL.sql,
    bindings: toSQL.bindings,
    expand: expandKey,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Fixed-permit semaphore used to bound concurrent `_reeval` work
 * across all cached queries. A burst write-storm on a hot table
 * schedules every cached query for re-eval at roughly the same ms;
 * without a cap, every re-eval hits the DB pool in parallel and
 * either queues on `acquireTimeoutMillis` or starves concurrent
 * request handlers. With the cap, work runs at most `permits` at a
 * time and the queue drains naturally.
 */
class Semaphore {
  private free: number;
  private waiters: Array<() => void> = [];
  private readonly capacity: number;
  constructor(permits: number) {
    this.free = permits;
    this.capacity = permits;
  }
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.free++;
    }
  }
  /** Number of acquisitions currently held — exposed for tests. */
  get inFlight(): number {
    return this.capacity - this.free;
  }
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
 * Default per-socket subscription cap. Without it, a misbehaving
 * client can subscribe to N distinct queries — each cached
 * server-side with its own row set + per-model-change re-eval cost —
 * and exhaust the server.
 *
 * 500 is sized for SPA navigation: the client SDK keeps each
 * subscription warm for ~60s after the React component unmounts
 * (cheap back-navigation), so a user clicking through ~50 detail
 * pages with ~10 useQuery calls each within that window stays under
 * the cap. Apps with heavier footprints can override via
 * `ManagerOptions.maxSubscriptionsPerSocket`.
 *
 * Hitting the cap is a runaway-render-loop mistake or an attack, not
 * a legitimate runtime case — log loudly and silently drop the new
 * subscription's items (the client gets an empty result for that
 * query, consistent with how an unsubscribed query reads).
 */
const DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET = 500;

const DEFAULT_DEBOUNCE_MS = 25;
const DEFAULT_MAX_WAIT_MS = 100;
const DEFAULT_REEVAL_CONCURRENCY = 8;

const EMPTY_EXPAND: readonly ResolvedExpand[] = Object.freeze([]);

export class QuerySubscriptionManager {
  private queries = new Map<string, CachedQuery>();
  private socketQueries = new Map<string, Set<string>>();
  private typeIndex = new Map<string, Set<string>>();
  /**
   * Secondary index from expanded-target-type → cached query hashes.
   * When a `File` row changes, every cached query that expanded
   * `file` (regardless of which parent type) needs a re-eval so the
   * inlined linked row stays fresh. v1 invalidation is naive: any
   * change to the target type wakes every subscriber that expanded
     * it, regardless of projection (field-aware invalidation is a follow-up).
   */
  private expandTargetIndex = new Map<string, Set<string>>();

  private emitToSocket: EmitToSocket;
  private emitToRoom: EmitToRoom | null;
  private joinRoom: JoinRoom | null;
  private leaveRoom: LeaveRoom | null;
  private defaultDebounceMs: number;
  private defaultMaxWaitMs: number;
  private reevalSemaphore: Semaphore;
  private maxSubscriptionsPerSocket: number;

  constructor(io: EmitToSocket | IoBackend, opts: ManagerOptions = {}) {
    // Two shapes for backward compatibility. The legacy form (a bare
    // function) is still used by every existing test fixture; the
    // room-aware form is what `createApp()` wires in production.
    if (typeof io === "function") {
      this.emitToSocket = io;
      this.emitToRoom = null;
      this.joinRoom = null;
      this.leaveRoom = null;
    } else {
      this.emitToSocket = io.emitToSocket;
      this.emitToRoom = io.emitToRoom ?? null;
      this.joinRoom = io.joinRoom ?? null;
      this.leaveRoom = io.leaveRoom ?? null;
    }
    this.defaultDebounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.defaultMaxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.reevalSemaphore = new Semaphore(
      Math.max(1, opts.reevalConcurrency ?? DEFAULT_REEVAL_CONCURRENCY),
    );
    this.maxSubscriptionsPerSocket = Math.max(
      1,
      opts.maxSubscriptionsPerSocket ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET,
    );
  }

  /** @internal — exposed for diagnostics + tests. */
  get reevalInFlight(): number {
    return this.reevalSemaphore.inFlight;
  }

  /** Resolve the room name for a cached query. Stable across re-evals. */
  private _roomFor(hash: string): string {
    return `query:${hash}`;
  }

  // ── Subscribe ──────────────────────────────────────────────────────

  async subscribe(
    opts: SubscriptionOptions,
    extra: SubscribeExtraOptions = {},
  ): Promise<{ hash: string; items: Record<string, any>[] }> {
    const { socketId, query, steps } = opts;
    const expand = opts.expand ?? EMPTY_EXPAND;
    const orderOptedOut = orderEmissionDisabled(steps);
    // `__modelType` lives on the QueryChain interface as @internal —
    // populated by every chain factory (`Model._query` → `lazyQuery`
    // server-side, the adapter's `query()` factory client-side).
    const modelType = query.__modelType;
    const hash = hashFrom(query.exec().toSQL(), expand);

    // Per-socket cap enforced BEFORE the cache lookup so a socket
    // can't unlock new subscriptions by re-requesting an already-
    // cached hash. The cap is on the socket's distinct-hash set
    // size, not on the cached query's total subscribers — sharing a
    // query across many sockets is fine and intentional.
    const existing = this.socketQueries.get(socketId);
    const alreadySubscribed = existing?.has(hash) ?? false;
    if (
      !alreadySubscribed &&
      (existing?.size ?? 0) >= this.maxSubscriptionsPerSocket
    ) {
      log.warn(
        `subscriptions: socket ${socketId} hit the ${this.maxSubscriptionsPerSocket} subscription cap — refusing new query for ${modelType}`,
      );
      return { hash, items: [] };
    }

    let cached = this.queries.get(hash);

    if (cached) {
      cached.subscribers.add(socketId);
      // Honour the most-restrictive emitOrder choice across all
      // subscribers sharing this hash: any single `orderBy(false)`
      // opts the channel out for everyone. Subscribers that wanted
      // order can't actually use it anyway if the SQL is identical.
      if (orderOptedOut) cached.emitOrder = false;
      // Drift-poll path: caller asked us to re-execute the cached
      // query against the DB and diff to every subscriber. We await
      // the re-eval so the LIST response that follows returns the
      // freshly-rebuilt items and the polling client converges in
      // one round-trip. Other subscribers receive any drift ops
      // through the normal `query:{hash}` channel.
      if (extra.force) {
        await this._forceReeval(cached);
      }
    } else {
      const rows = await this._execQuery(query, expand);
      const result = new Map<string, Record<string, any>>();
      for (const row of rows) {
        const clean = dateSafeClone(row);
        result.set(clean.id, clean);
      }

      const overrides = realtimeOverridesFor(query);
      cached = {
        hash,
        modelType,
        query,
        expand,
        result,
        subscribers: new Set([socketId]),
        emitOrder: !orderOptedOut,
        coalesce: {
          debounceTimer: null,
          maxWaitTimer: null,
          inFlight: null,
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

      // Cross-type invalidation index: whenever any of this query's
      // expanded targets is written, this hash needs a re-eval.
      for (const exp of expand) {
        let bucket = this.expandTargetIndex.get(exp.targetType);
        if (!bucket) {
          bucket = new Set();
          this.expandTargetIndex.set(exp.targetType, bucket);
        }
        bucket.add(hash);
      }
    }

    if (!this.socketQueries.has(socketId)) {
      this.socketQueries.set(socketId, new Set());
    }
    this.socketQueries.get(socketId)!.add(hash);

    // When the IO backend supports rooms, join the socket so the
    // `_reeval` broadcast (`io.to(room).emit`) reaches it. Skipped on
    // re-subscribe: Socket.IO's `join` is idempotent but the call
    // round-trips through the adapter, so guard on alreadySubscribed.
    if (this.joinRoom && !alreadySubscribed) {
      this.joinRoom(socketId, this._roomFor(hash));
    }

    return { hash, items: [...cached.result.values()] };
  }

  // ── Unsubscribe ────────────────────────────────────────────────────

  unsubscribe(socketId: string, hash: string): void {
    const cached = this.queries.get(hash);
    if (!cached) return;

    const wasSubscribed = cached.subscribers.delete(socketId);
    this.socketQueries.get(socketId)?.delete(hash);

    if (wasSubscribed && this.leaveRoom) {
      this.leaveRoom(socketId, this._roomFor(hash));
    }

    if (cached.subscribers.size === 0) {
      this._teardownCoalesce(cached);
      this.queries.delete(hash);
      this.typeIndex.get(cached.modelType)?.delete(hash);
      for (const exp of cached.expand) {
        this.expandTargetIndex.get(exp.targetType)?.delete(hash);
      }
    }
  }

  unsubscribeAll(socketId: string): void {
    const hashes = this.socketQueries.get(socketId);
    if (!hashes) return;

    for (const hash of hashes) {
      const cached = this.queries.get(hash);
      if (!cached) continue;
      const wasSubscribed = cached.subscribers.delete(socketId);
      if (wasSubscribed && this.leaveRoom) {
        this.leaveRoom(socketId, this._roomFor(hash));
      }
      if (cached.subscribers.size === 0) {
        this._teardownCoalesce(cached);
        this.queries.delete(hash);
        this.typeIndex.get(cached.modelType)?.delete(hash);
        for (const exp of cached.expand) {
          this.expandTargetIndex.get(exp.targetType)?.delete(hash);
        }
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
    // Primary path: direct subscribers to this model type.
    const direct = this.typeIndex.get(modelType);
    if (direct) {
      for (const hash of direct) {
        const cached = this.queries.get(hash);
        if (!cached) continue;
        this._scheduleReeval(cached);
      }
    }

    // Expand-aware cross-type invalidation: a `File` write wakes
    // every cached query that expanded `file`, regardless of the
    // parent model type. v1 is naive — no field-aware filtering —
    // so a `File.blurhash` change re-emits even to subscribers that
     // only projected `file.url`. This over-notifies but stays correct.
    const viaExpand = this.expandTargetIndex.get(modelType);
    if (!viaExpand || viaExpand.size === 0) return;
    for (const hash of viaExpand) {
      // Skip queries we already woke through the direct index (a
      // query whose parent type IS the changed type AND that expands
      // the same type back into itself — pathological but possible).
      if (direct?.has(hash)) continue;
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

  private _runReeval(cached: CachedQuery): Promise<void> {
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
    const run = (async () => {
      // Bound the parallel DB hits across the whole manager. Without
      // the semaphore, N distinct cached queries all hitting `onModelChange`
      // in the same tick launch N concurrent SELECTs and either queue
      // on the pool or starve unrelated handlers.
      await this.reevalSemaphore.acquire();
      try {
        await this._reeval(cached);
      } catch (err) {
        log.error(`subscriptions: re-eval failed for ${cached.hash}:`, err);
      } finally {
        this.reevalSemaphore.release();
        c.inFlight = null;
      }
      if (c.needsFollowup) {
        // A change arrived mid-re-eval. Schedule a follow-up so we
        // converge against the latest world state.
        this._scheduleReeval(cached);
      }
    })();
    c.inFlight = run;
    return run;
  }

  /**
   * Force path — the client drift poll (`__forceRefresh: true`).
   *
   * Runs through the SAME inFlight + semaphore protocol as the
   * debounced path. The poll is timer-driven (every client, every
   * `poll` interval), so calling `_reeval` directly here would both
   * bypass the `reevalConcurrency` cap the ManagerOptions contract
   * promises AND race a debounced re-eval mid-flight on the same
   * cached query (two concurrent `_reeval`s diff against — and swap —
   * the same `cached.result`).
   *
   * If a re-eval is already in flight, wait for it to land and run a
   * fresh one: the in-flight run's DB read may predate the drift this
   * poll is asking about. Any timers armed by a follow-up are
   * absorbed — `_runReeval` clears them on entry.
   */
  private async _forceReeval(cached: CachedQuery): Promise<void> {
    const c = cached.coalesce;
    while (c.inFlight) await c.inFlight;
    await this._runReeval(cached);
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

    const rows = await this._execQuery(cached.query, cached.expand);
    const newResult = new Map<string, Record<string, any>>();
    for (const row of rows) {
      const clean = dateSafeClone(row);
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
    //
    // Queries that opted out via `.orderBy(false)` get no order
    // envelope, ever. We still emit op-only frames when ops exist;
    // we just never compute or ship the ordered id list.
    let includeOrder = false;
    let newOrder: string[] = [];
    if (cached.emitOrder) {
      const prevOrder = [...cached.result.keys()];
      newOrder = [...newResult.keys()];
      const hasMembershipChange = ops.some(
        (o) => o.op === "add" || o.op === "remove",
      );
      const orderChanged = !ordersEqual(prevOrder, newOrder);
      includeOrder = hasMembershipChange || orderChanged;
    }

    cached.result = newResult;

    if (ops.length === 0 && !includeOrder) return;

    const envelope: QueryEmitEnvelope = includeOrder
      ? { ops, order: newOrder }
      : { ops };

    const event = `query:${cached.hash}`;
    if (this.emitToRoom) {
      // Single broadcast — Socket.IO walks the room's socket set and
      // emits to each transport in one pass. For N subscribers this
      // is O(1) emits at the manager layer instead of O(N).
      this.emitToRoom(this._roomFor(cached.hash), event, envelope);
    } else {
      for (const socketId of cached.subscribers) {
        this.emitToSocket(socketId, event, envelope);
      }
    }
  }

  // ── Query Execution ────────────────────────────────────────────────

  private async _execQuery(
    query: QueryChain<any>,
    expand: readonly ResolvedExpand[],
  ): Promise<Record<string, any>[]> {
    const models = await query.clone().find();
    // `query.find()` returns `Promise<any[]>` (the chain's generic is
    // `any`); the projection runs `sanitize()` for every Model row
    // and falls back to `__data` for any non-Model row that snuck
    // through (defensive — the default `sanitize` is now on Model
    // itself, so the fallback is effectively unreachable for real
    // model classes).
    const wireRows = await Promise.all(
      models.map((m: any) => m.sanitize?.() ?? m.__data ?? m),
    );

    if (expand.length === 0) return wireRows;

    // Build an ephemeral RefLoader pointed at the adapter's batch
    // entrypoint. This runs OUTSIDE a request scope (re-eval fires
    // on `onModelChange`, which has no AsyncLocalStorage frame), so
    // we can't reuse `getRefLoader()`. The per-reeval loader still
    // collapses every ref-id-per-row into one query per target
    // type via the same microtask batching.
    const adapter = (query as any).__adapter as
      | {
          batchFindByType?: (type: string, ids: string[]) => Promise<Map<string, any>>;
        }
      | null;
    if (!adapter?.batchFindByType) return wireRows;
    const loader = new RefLoader((type, ids) =>
      adapter.batchFindByType!(type, ids),
    );
    // No request user available outside a request scope. Privacy-
    // sensitive refs (e.g. expanding a `user` ref with private
    // fields) would need to opt in via subscription-time user
    // carriage — out of scope for v1 since the only expanded ref in
    // anger right now is `File`, which has no `privateFields`.
    await hydrateExpansions(wireRows, expand, loader, null);
    return wireRows;
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
