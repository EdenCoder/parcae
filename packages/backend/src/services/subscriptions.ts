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
  getWireRefId,
  hydrateExpansions,
  projectForWire,
  type ResolvedExpand,
} from "./hydrate-expansions";
import type { Change } from "./change-bus";

// ─── Types ───────────────────────────────────────────────────────────────────

type DiffOp =
  | { op: "add"; id: string; data: Record<string, any> }
  | { op: "remove"; id: string }
  | { op: "update"; id: string; patch: Operation[] };

type SanitizerUser = { id: string; [key: string]: unknown } | null;

/** Wire envelope sent on `query:{hash}`. */
export interface QueryEmitEnvelope {
  ops: DiffOp[];
  /** Ordered id list, present whenever membership/order changed. */
  order?: string[];
}

interface CachedQuery {
  hash: string;
  /** Invalidated before this cache identity is removed or replaced. */
  generation: number;
  modelType: string;
  query: QueryChain<any>;
  /** Request user used for model `sanitize(user)` during re-evals. */
  user: SanitizerUser;
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
  dependency: {
    hasLimit: boolean;
    hasOffset: boolean;
    hasOpaqueOrder: boolean;
    hasStableOrder: boolean;
    orderFields: ReadonlySet<string>;
  };
  creationReconcile: Promise<void> | null;
  needsCreationReconcile: boolean;
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
    full: boolean;
    root: Map<string, Change>;
    expand: Map<string, { modelType: string; change: Change }>;
    /** Override window from `Model.realtime` or manager default. */
    debounceMs: number;
    maxWaitMs: number;
  };
}

interface SubscriptionOptions {
  socketId: string;
  query: QueryChain<any>;
  /** Request user used for model `sanitize(user)` during cache builds. */
  user?: SanitizerUser;
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
  user: SanitizerUser,
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
  const payload = stableStringify({
    sql: toSQL.sql,
    bindings: toSQL.bindings,
    expand: expandKey,
    user,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return current;
    }
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    );
  });
}

function dependencyPlan(
  query: QueryChain<any>,
  steps: readonly QueryStep[] | undefined,
  sql: string,
): CachedQuery["dependency"] {
  const orderFields = new Set<string>();
  const hasLimit = /\blimit\b/i.test(sql);
  let hasOffset = /\boffset\b/i.test(sql);
  for (const step of steps ?? []) {
    if (step.method === "offset" && Number(step.args[0]) > 0) hasOffset = true;
    if (step.method === "orderBy" && typeof step.args[0] === "string") {
      orderFields.add(step.args[0]);
    }
    if (
      step.method === "search" &&
      typeof step.args[0] === "string" &&
      step.args[0].trim().length > 0
    ) {
      const searchFields = query.__modelClass.searchFields ?? [];
      for (const field of searchFields) orderFields.add(field);
    }
  }
  const orderClause = sql.match(
    /\border\s+by\s+(.+?)(?:\s+limit\b|\s+offset\b|$)/i,
  )?.[1];
  const parsedOrderFields = new Set<string>();
  let hasOpaqueOrder = false;
  if (orderClause) {
    for (const term of orderClause.split(",")) {
      const match = term.trim().match(
        /^(?:(?:"[^"]+"|[a-zA-Z_]\w*)\.)?(?:"([^"]+)"|([a-zA-Z_]\w*))(?:\s+(?:asc|desc))?(?:\s+nulls\s+(?:first|last))?$/i,
      );
      const field = match?.[1] ?? match?.[2];
      if (!field || !orderFields.has(field)) {
        hasOpaqueOrder = true;
        break;
      }
      parsedOrderFields.add(field);
    }
    if (parsedOrderFields.size !== orderFields.size) hasOpaqueOrder = true;
    if (!parsedOrderFields.has("id")) hasOpaqueOrder = true;
  }
  return {
    hasLimit,
    hasOffset,
    hasOpaqueOrder,
    hasStableOrder:
      Boolean(orderClause) &&
      !hasOpaqueOrder &&
      parsedOrderFields.has("id"),
    orderFields,
  };
}

function mergeChange(previous: Change | undefined, next: Change): Change {
  if (!previous) return next;
  const changedFields =
    previous.changedFields === null || next.changedFields === null
      ? null
      : Array.from(
          new Set([...previous.changedFields, ...next.changedFields]),
        );
  return { ...next, changedFields };
}

export function parsePositiveInteger(
  value: string | number | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a finite positive integer`);
  }
  return parsed;
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
  private creating = new Map<string, Promise<CachedQuery>>();
  private socketQueries = new Map<string, Set<string>>();
  private socketGenerations = new Map<string, number>();
  private pendingSockets = new Map<string, number>();
  private typeIndex = new Map<string, Set<string>>();
  private changeRevisions = new Map<string, number>();
  private refreshRevision = 0;
  /**
   * Secondary index from expanded-target-type → cached query hashes.
   * When a `File` row changes, every cached query that expanded
   * `file` can cheaply identify cached parents that reference that id.
   * Field-aware projection filtering remains a follow-up.
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
      parsePositiveInteger(
        opts.reevalConcurrency ?? DEFAULT_REEVAL_CONCURRENCY,
        "reevalConcurrency",
      )!,
    );
    this.maxSubscriptionsPerSocket = parsePositiveInteger(
      opts.maxSubscriptionsPerSocket ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET,
      "maxSubscriptionsPerSocket",
    )!;
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
    const user: SanitizerUser = opts.user ? dateSafeClone(opts.user) : null;
    const expand = opts.expand ?? EMPTY_EXPAND;
    const orderOptedOut = orderEmissionDisabled(steps);
    // `__modelType` lives on the QueryChain interface as @internal —
    // populated by every chain factory (`Model._query` → `lazyQuery`
    // server-side, the adapter's `query()` factory client-side).
    const modelType = query.__modelType;
    const compiled = query.exec().toSQL();
    const hash = hashFrom(compiled, expand, user);
    const socketGeneration = this.socketGenerations.get(socketId) ?? 0;

    // Per-socket cap enforced BEFORE the cache lookup so a socket
    // can't unlock new subscriptions by re-requesting an already-
    // cached hash. The cap is on the socket's distinct-hash set
    // size, not on the cached query's total subscribers — sharing a
    // query across many sockets is fine and intentional.
    let socketHashes = this.socketQueries.get(socketId);
    const alreadySubscribed = socketHashes?.has(hash) ?? false;
    if (
      !alreadySubscribed &&
      (socketHashes?.size ?? 0) >= this.maxSubscriptionsPerSocket
    ) {
      log.warn(
        `subscriptions: socket ${socketId} hit the ${this.maxSubscriptionsPerSocket} subscription cap — refusing new query for ${modelType}`,
      );
      return { hash, items: [] };
    }

    const reserved = !alreadySubscribed;
    if (reserved) {
      if (!socketHashes) {
        socketHashes = new Set();
        this.socketQueries.set(socketId, socketHashes);
      }
      socketHashes.add(hash);
    }
    this.pendingSockets.set(
      socketId,
      (this.pendingSockets.get(socketId) ?? 0) + 1,
    );

    try {
      let cached = this.queries.get(hash);
      let created = false;
      if (!cached) {
        let creation = this.creating.get(hash);
        if (!creation) {
          created = true;
          creation = this._createCached({
            hash,
            modelType,
            query,
            user,
            expand,
            emitOrder: !orderOptedOut,
            dependency: dependencyPlan(query, steps, compiled.sql),
          });
          this.creating.set(hash, creation);
        }
        try {
          cached = await creation;
        } finally {
          if (this.creating.get(hash) === creation) this.creating.delete(hash);
        }
      }

      if (
        (this.socketGenerations.get(socketId) ?? 0) !== socketGeneration ||
        !this.socketQueries.get(socketId)?.has(hash)
      ) {
        this._deleteCachedIfUnused(cached);
        return { hash, items: [] };
      }

      cached.subscribers.add(socketId);
      // Honour the most-restrictive emitOrder choice across all subscribers
      // sharing this hash.
      if (orderOptedOut) cached.emitOrder = false;
      await this._reconcileCreation(cached);
      if (extra.force && !created) await this._forceReeval(cached);
      if (
        (this.socketGenerations.get(socketId) ?? 0) !== socketGeneration ||
        !this.socketQueries.get(socketId)?.has(hash)
      ) {
        cached.subscribers.delete(socketId);
        this._deleteCachedIfUnused(cached);
        return { hash, items: [] };
      }

      // When the IO backend supports rooms, join the socket so the
      // `_reeval` broadcast (`io.to(room).emit`) reaches it. Skipped on
      // re-subscribe: Socket.IO's `join` is idempotent but the call
      // round-trips through the adapter, so guard on alreadySubscribed.
      if (this.joinRoom && !alreadySubscribed) {
        this.joinRoom(socketId, this._roomFor(hash));
      }

      return { hash, items: [...cached.result.values()] };
    } catch (err) {
      if (reserved) this._releaseReservation(socketId, hash);
      throw err;
    } finally {
      const pending = (this.pendingSockets.get(socketId) ?? 1) - 1;
      if (pending > 0) this.pendingSockets.set(socketId, pending);
      else {
        this.pendingSockets.delete(socketId);
        if (!this.socketQueries.has(socketId)) {
          this.socketGenerations.delete(socketId);
        }
      }
    }
  }

  private _releaseReservation(socketId: string, hash: string): void {
    this.unsubscribe(socketId, hash);
  }

  private async _createCached(opts: {
    hash: string;
    modelType: string;
    query: QueryChain<any>;
    user: SanitizerUser;
    expand: readonly ResolvedExpand[];
    emitOrder: boolean;
    dependency: CachedQuery["dependency"];
  }): Promise<CachedQuery> {
    const { hash, modelType, query, user, expand, emitOrder, dependency } = opts;
    const watchedTypes = new Set([
      modelType,
      ...expand.map((entry) => entry.targetType),
    ]);
    const revisions = new Map(
      [...watchedTypes].map((type) => [
        type,
        this.changeRevisions.get(type) ?? 0,
      ]),
    );
    const refreshRevision = this.refreshRevision;
    const rows = await this._execQuery(query, expand, user);
    const result = new Map<string, Record<string, any>>();
    for (const row of rows) {
      const clean = dateSafeClone(row);
      result.set(clean.id, clean);
    }

    const overrides = realtimeOverridesFor(query);
    const cached: CachedQuery = {
      hash,
      generation: 0,
      modelType,
      query,
      user,
      expand,
      result,
      subscribers: new Set(),
      emitOrder,
      dependency,
      creationReconcile: null,
      needsCreationReconcile: false,
      coalesce: {
        debounceTimer: null,
        maxWaitTimer: null,
        inFlight: null,
        needsFollowup: false,
        full: false,
        root: new Map(),
        expand: new Map(),
        debounceMs: overrides.debounceMs ?? this.defaultDebounceMs,
        maxWaitMs: overrides.maxWaitMs ?? this.defaultMaxWaitMs,
      },
    };
    this.queries.set(hash, cached);

    if (!this.typeIndex.has(modelType)) {
      this.typeIndex.set(modelType, new Set());
    }
    this.typeIndex.get(modelType)!.add(hash);
    for (const exp of expand) {
      let bucket = this.expandTargetIndex.get(exp.targetType);
      if (!bucket) {
        bucket = new Set();
        this.expandTargetIndex.set(exp.targetType, bucket);
      }
      bucket.add(hash);
    }
    cached.needsCreationReconcile =
      refreshRevision !== this.refreshRevision ||
      [...revisions].some(
        ([type, revision]) =>
          (this.changeRevisions.get(type) ?? 0) !== revision,
      );
    return cached;
  }

  private async _reconcileCreation(cached: CachedQuery): Promise<void> {
    if (this._hasPendingRefresh(cached)) {
      cached.needsCreationReconcile = true;
    }
    if (cached.creationReconcile) {
      await cached.creationReconcile;
      return;
    }
    if (!cached.needsCreationReconcile) return;
    cached.needsCreationReconcile = false;
    const reconciliation = this._forceReeval(cached);
    cached.creationReconcile = reconciliation;
    try {
      await reconciliation;
    } finally {
      if (cached.creationReconcile === reconciliation) {
        cached.creationReconcile = null;
      }
    }
  }

  private _hasPendingRefresh(cached: CachedQuery): boolean {
    const c = cached.coalesce;
    return c.full || c.root.size > 0 || c.expand.size > 0;
  }

  // ── Unsubscribe ────────────────────────────────────────────────────

  unsubscribe(socketId: string, hash: string): void {
    const hashes = this.socketQueries.get(socketId);
    hashes?.delete(hash);
    if (hashes?.size === 0) this.socketQueries.delete(socketId);

    const cached = this.queries.get(hash);
    if (!cached) return;

    const wasSubscribed = cached.subscribers.delete(socketId);

    if (wasSubscribed && this.leaveRoom) {
      this.leaveRoom(socketId, this._roomFor(hash));
    }

    this._deleteCachedIfUnused(cached);
  }

  unsubscribeAll(socketId: string): void {
    this.socketGenerations.set(
      socketId,
      (this.socketGenerations.get(socketId) ?? 0) + 1,
    );
    const hashes = this.socketQueries.get(socketId);
    if (!hashes) {
      if (!this.pendingSockets.has(socketId)) {
        this.socketGenerations.delete(socketId);
      }
      return;
    }
    this.socketQueries.delete(socketId);

    for (const hash of hashes) {
      const cached = this.queries.get(hash);
      if (!cached) continue;
      const wasSubscribed = cached.subscribers.delete(socketId);
      if (wasSubscribed && this.leaveRoom) {
        this.leaveRoom(socketId, this._roomFor(hash));
      }
      this._deleteCachedIfUnused(cached);
    }
  }

  private _deleteCachedIfUnused(cached: CachedQuery): void {
    if (cached.subscribers.size > 0 || this._hasReservation(cached.hash)) return;
    if (this.queries.get(cached.hash) !== cached) return;
    cached.generation++;
    this._teardownCoalesce(cached);
    this.queries.delete(cached.hash);
    this.typeIndex.get(cached.modelType)?.delete(cached.hash);
    for (const exp of cached.expand) {
      this.expandTargetIndex.get(exp.targetType)?.delete(cached.hash);
    }
  }

  private _hasReservation(hash: string): boolean {
    for (const hashes of this.socketQueries.values()) {
      if (hashes.has(hash)) return true;
    }
    return false;
  }

  // ── On Model Change ────────────────────────────────────────────────

  /** Route one committed Postgres row change to affected local caches. */
  onModelChange(modelType: string, change?: Change): void {
    this.changeRevisions.set(
      modelType,
      (this.changeRevisions.get(modelType) ?? 0) + 1,
    );
    const direct = this.typeIndex.get(modelType);
    if (direct) {
      for (const hash of direct) {
        const cached = this.queries.get(hash);
        if (!cached) continue;
        if (!change || this._requiresFullReeval(cached, change)) {
          this._scheduleFullReeval(cached);
        } else {
          this._scheduleRootRefresh(cached, change);
        }
      }
    }

    const viaExpand = this.expandTargetIndex.get(modelType);
    if (!viaExpand || viaExpand.size === 0) return;
    for (const hash of viaExpand) {
      const cached = this.queries.get(hash);
      if (!cached) continue;
      if (!change) {
        this._scheduleFullReeval(cached);
        continue;
      }
      const referencesRow = cached.expand.some(
        (exp) =>
          exp.targetType === modelType &&
          [...cached.result.values()].some(
            (row) => getWireRefId(row, exp.refField) === change.id,
          ),
      );
      if (referencesRow) this._scheduleExpandRefresh(cached, modelType, change);
    }
  }

  /** Reconcile every local cache after a non-durable LISTEN connection gap. */
  refreshAll(): void {
    this.refreshRevision++;
    for (const cached of this.queries.values()) {
      this._scheduleFullReeval(cached);
    }
  }

  // ── Re-evaluation ──────────────────────────────────────────────────

  private _requiresFullReeval(cached: CachedQuery, change: Change): boolean {
    if (change.op !== "update") return true;
    if (cached.dependency.hasOffset || cached.dependency.hasOpaqueOrder) {
      return true;
    }
    if (
      cached.dependency.hasLimit &&
      !cached.dependency.hasStableOrder
    ) {
      return true;
    }
    if (change.changedFields === null) return true;
    return change.changedFields.some(
      (field) =>
        field === "id" || cached.dependency.orderFields.has(field),
    );
  }

  private _scheduleFullReeval(cached: CachedQuery): void {
    cached.coalesce.full = true;
    cached.coalesce.root.clear();
    cached.coalesce.expand.clear();
    this._schedule(cached);
  }

  private _scheduleRootRefresh(cached: CachedQuery, change: Change): void {
    const c = cached.coalesce;
    if (!c.full) c.root.set(change.id, mergeChange(c.root.get(change.id), change));
    this._schedule(cached);
  }

  private _scheduleExpandRefresh(
    cached: CachedQuery,
    modelType: string,
    change: Change,
  ): void {
    const c = cached.coalesce;
    if (!c.full) {
      const key = `${modelType}\0${change.id}`;
      const previous = c.expand.get(key);
      c.expand.set(key, {
        modelType,
        change: mergeChange(previous?.change, change),
      });
    }
    this._schedule(cached);
  }

  private _schedule(cached: CachedQuery): void {
    if (this.queries.get(cached.hash) !== cached) return;
    const c = cached.coalesce;
    if (cached.subscribers.size === 0) return;

    if (c.inFlight) {
      c.needsFollowup = true;
      return;
    }

    // Fast-path: both windows at 0 → fire synchronously. Used by
    // tests that want predictable behaviour, and by call sites that
    // turn coalescing off via `Model.realtime`.
    if (c.debounceMs <= 0 && c.maxWaitMs <= 0) {
      void this._runRefresh(cached);
      return;
    }

    // Reset the trailing debounce on every signal. Whichever timer
    // fires first wins; both get cleared at that point.
    if (c.debounceTimer) clearTimeout(c.debounceTimer);
    c.debounceTimer = setTimeout(() => {
      void this._runRefresh(cached);
    }, c.debounceMs);

    // Max-wait fires regardless. Only armed on the first signal of
    // the current window so a steady stream of writes can't push it
    // back indefinitely.
    if (!c.maxWaitTimer) {
      c.maxWaitTimer = setTimeout(() => {
        void this._runRefresh(cached);
      }, c.maxWaitMs);
    }
  }

  private _runRefresh(cached: CachedQuery): Promise<void> {
    const c = cached.coalesce;
    if (c.debounceTimer) {
      clearTimeout(c.debounceTimer);
      c.debounceTimer = null;
    }
    if (c.maxWaitTimer) {
      clearTimeout(c.maxWaitTimer);
      c.maxWaitTimer = null;
    }

    const full = c.full;
    const root = [...c.root.values()];
    const expand = [...c.expand.values()];
    c.full = false;
    c.root.clear();
    c.expand.clear();
    c.needsFollowup = false;
    const run = (async () => {
      // Bound the parallel DB hits across the whole manager. Without
      // the semaphore, N distinct cached queries all hitting `onModelChange`
      // in the same tick launch N concurrent SELECTs and either queue
      // on the pool or starve unrelated handlers.
      await this.reevalSemaphore.acquire();
      try {
        let didFullReeval = full;
        if (full) {
          await this._reeval(cached);
        } else {
          for (const change of root) {
            if (await this._refreshRoot(cached, change.id)) {
              didFullReeval = true;
              break;
            }
          }
          if (!didFullReeval) {
            for (const pending of expand) {
              await this._refreshExpand(
                cached,
                pending.modelType,
                pending.change,
              );
            }
          }
        }
      } catch (err) {
        if (!full) {
          log.warn(
            `subscriptions: targeted refresh failed for ${cached.hash}; falling back to full re-eval`,
            err,
          );
          try {
            await this._reeval(cached);
          } catch (fallbackError) {
            log.error(
              `subscriptions: fallback re-eval failed for ${cached.hash}:`,
              fallbackError,
            );
          }
        } else {
          log.error(`subscriptions: re-eval failed for ${cached.hash}:`, err);
        }
      } finally {
        this.reevalSemaphore.release();
        c.inFlight = null;
      }
      if (
        c.needsFollowup ||
        c.full ||
        c.root.size > 0 ||
        c.expand.size > 0
      ) {
        c.needsFollowup = false;
        this._schedule(cached);
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
   * absorbed — `_runRefresh` clears them on entry.
   */
  private async _forceReeval(cached: CachedQuery): Promise<void> {
    const c = cached.coalesce;
    while (c.inFlight) await c.inFlight;
    c.full = true;
    c.root.clear();
    c.expand.clear();
    await this._runRefresh(cached);
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
    c.full = false;
    c.root.clear();
    c.expand.clear();
  }

  /** Refresh one row through the original scoped query. Returns true on fallback. */
  private async _refreshRoot(cached: CachedQuery, id: string): Promise<boolean> {
    if (cached.subscribers.size === 0) return false;
    const generation = cached.generation;
    const query = cached.query
      .clone()
      .where("id", id)
      .clearLimit();
    const adapter = this._queryAdapter(cached.query);
    const model = adapter?.executeSubscriptionQuery
      ? (await adapter.executeSubscriptionQuery(query.limit(1)))[0] ?? null
      : await query.first();
    if (!this._isCurrent(cached, generation)) return false;

    const previous = cached.result.get(id);
    if (!model || !previous) {
      if (model || previous) await this._reeval(cached);
      return Boolean(model || previous);
    }

    const rows = [await projectForWire(model, cached.user)];
    await this._hydrateRows(cached.query, rows, cached.expand, cached.user);
    if (!this._isCurrent(cached, generation)) return false;
    const data = dateSafeClone(rows[0]!);
    const patch = stripVolatilePatchOps(fastJsonPatch.compare(previous, data));
    cached.result.set(id, data);
    if (patch.length > 0) {
      this._emit(cached, { ops: [{ op: "update", id, patch }] });
    }
    return false;
  }

  /** Rehydrate only cached parents that point at the changed target row. */
  private async _refreshExpand(
    cached: CachedQuery,
    modelType: string,
    change: Change,
  ): Promise<void> {
    if (cached.subscribers.size === 0) return;
    const generation = cached.generation;
    const expand = cached.expand.filter(
      (entry) => entry.targetType === modelType,
    );
    const rows = [...cached.result.values()]
      .filter((row) =>
        expand.some(
          (entry) => getWireRefId(row, entry.refField) === change.id,
        ),
      )
      .map((row) => dateSafeClone(row));
    if (rows.length === 0) return;

    await this._hydrateRows(cached.query, rows, expand, cached.user);
    if (!this._isCurrent(cached, generation)) return;
    const ops: DiffOp[] = [];
    for (const data of rows) {
      const previous = cached.result.get(data.id);
      if (!previous) continue;
      const patch = stripVolatilePatchOps(fastJsonPatch.compare(previous, data));
      cached.result.set(data.id, data);
      if (patch.length > 0) {
        ops.push({ op: "update", id: data.id, patch });
      }
    }
    if (ops.length > 0) this._emit(cached, { ops });
  }

  private _isCurrent(cached: CachedQuery, generation: number): boolean {
    return (
      cached.generation === generation &&
      this.queries.get(cached.hash) === cached &&
      cached.subscribers.size > 0
    );
  }

  private async _reeval(cached: CachedQuery): Promise<void> {
    if (cached.subscribers.size === 0) return;
    const generation = cached.generation;

    const rows = await this._execQuery(
      cached.query,
      cached.expand,
      cached.user,
    );
    if (!this._isCurrent(cached, generation)) return;
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

    this._emit(cached, envelope);
  }

  private _emit(cached: CachedQuery, envelope: QueryEmitEnvelope): void {
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
    user: SanitizerUser,
  ): Promise<Record<string, any>[]> {
    const cloned = query.clone();
    const adapter = this._queryAdapter(query);
    const models = adapter?.executeSubscriptionQuery
      ? await adapter.executeSubscriptionQuery(cloned)
      : await cloned.find();
    // `query.find()` returns `Promise<any[]>` (the chain's generic is
    // `any`); the projection runs `sanitize()` for every Model row
    // and falls back to `__data` for any non-Model row that snuck
    // through (defensive — the default `sanitize` is now on Model
    // itself, so the fallback is effectively unreachable for real
    // model classes).
    const wireRows = await Promise.all(
      models.map((model) => projectForWire(model, user)),
    );

    await this._hydrateRows(query, wireRows, expand, user);
    return wireRows;
  }

  private async _hydrateRows(
    query: QueryChain<any>,
    wireRows: Record<string, any>[],
    expand: readonly ResolvedExpand[],
    user: SanitizerUser,
  ): Promise<void> {
    if (expand.length === 0 || wireRows.length === 0) return;

    // Build an ephemeral RefLoader pointed at the adapter's batch
    // entrypoint. This runs OUTSIDE a request scope (re-eval fires
    // on `onModelChange`, which has no AsyncLocalStorage frame), so
    // we can't reuse `getRefLoader()`. The per-reeval loader still
    // collapses every ref-id-per-row into one query per target
    // type via the same microtask batching.
    const adapter = this._queryAdapter(query);
    const batch =
      adapter?.batchFindByTypeOnWrite ?? adapter?.batchFindByType;
    if (!batch) return;
    const loader = new RefLoader((type, ids) => batch.call(adapter, type, ids));
    await hydrateExpansions(wireRows, expand, loader, user ?? undefined);
  }

  private _queryAdapter(query: QueryChain<any>): {
    batchFindByType?: (
      type: string,
      ids: string[],
    ) => Promise<Map<string, any>>;
    batchFindByTypeOnWrite?: (
      type: string,
      ids: string[],
    ) => Promise<Map<string, any>>;
    executeSubscriptionQuery?: (query: QueryChain<any>) => Promise<any[]>;
  } | null {
    return (query as any).__adapter ?? null;
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
