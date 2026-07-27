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
import { ClientError } from "../helpers";
import { RefLoader } from "./ref-loader";
import { hydrateExpansions, type ResolvedExpand } from "./hydrate-expansions";

// ─── Types ───────────────────────────────────────────────────────────────────

type DiffOp =
  | { op: "add"; id: string; data: Record<string, any> }
  | { op: "remove"; id: string }
  | { op: "update"; id: string; patch: Operation[] };

interface SubscriberAttachment {
  generation: number;
  /**
   * Transaction that may roll this attachment back. `null` means another
   * caller adopted it, so it must survive the original caller's rollback.
   */
  owner: object | null;
}

/** Wire envelope sent on `query:{hash}`. */
export interface QueryEmitEnvelope {
  ops: DiffOp[];
  /** Ordered id list, present whenever membership/order changed. */
  order?: string[];
}

interface CachedQuery {
  hash: string;
  modelType: string;
  query: QueryChain<any> | null;
  /**
   * Minimal immutable authorization principal used for every parent/ref
   * projection. Never retain the full request user or AuthSession here.
   */
  principal: Readonly<{ id: string }> | null;
  /** True after the final subscriber leaves and retained PHI is scrubbed. */
  disposed: boolean;
  /**
   * Per-query ref expansions recorded by `.expand(...)`. Drives the
   * per-emit `hydrateExpansions` pass that inlines linked rows in
   * the cached result. Empty when the subscriber didn't ask for any
   * expansions — identical to the pre-DOL-1093 emit path.
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
  /** socket id → current rollback ownership and generation fence. */
  subscribers: Map<string, SubscriberAttachment>;
  /**
   * Whether to emit the `order` field on the wire envelope. `false`
   * when the query carries `.orderBy(false)` — consumers don't
   * care about the ordered id list and we save bytes + spare the
   * client a `reorderByIds` pass (DOL-1101).
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
  /**
   * Stable identity for the reconciled socket authorization boundary.
   * Production callers must change this whenever the socket's token/session
   * is reconciled, even when the user id remains the same.
   */
  sessionLease?: string;
  /** Minimal identity accepted by Model.sanitize(). */
  principal?: { id: string } | null;
  /**
   * Optional authorization-boundary guard for socket-backed subscriptions.
   * Checked immediately before every subscriber commit so async query work
   * cannot attach an obsolete owner's subscription after the socket changes
   * session.
   */
  isActive?: () => boolean;
  /**
   * Opaque transaction identity for rollback-safe batch attachment. Reuses
   * with the same owner remain rollback-eligible; any other reuse adopts the
   * attachment and clears that eligibility.
   */
  attachmentOwner?: object;
  /**
   * Per-query ref expansions recorded by `.expand(...)` on the
   * client. Subscriptions with different expand projections live as
   * distinct cached queries (the hash includes the projection key
   * via `expandHashKey`) so emits ship the right shape per
   * consumer. Empty → no expansions, identical to pre-DOL-1093
   * behavior.
   */
  expand?: readonly ResolvedExpand[];
  /**
   * Raw client-sent steps. Used to detect `.orderBy(false)` so the
   * subscriptions manager skips order envelope emission for queries
   * whose consumers don't care about ordering (DOL-1101).
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
 * Socket.IO backend hooks. A bare callback emits once per current logical
 * subscriber. The object form may provide `emitToSockets` to target the exact
 * current socket-id set in one adapter call. Query rooms are deliberately not
 * used: asynchronous room leave can outlive an authorization boundary.
 */
type EmitToSocket = (socketId: string, event: string, data: any) => void;
type EmitToSockets = (
  socketIds: readonly string[],
  event: string,
  data: any,
) => void;

interface IoBackend {
  emitToSocket: EmitToSocket;
  /** Optional exact-target batch emit. */
  emitToSockets?: EmitToSockets;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashFrom(
  toSQL: { sql: string; bindings: any[] },
  expand: readonly ResolvedExpand[],
  principalId: string | null,
  sessionLease: string,
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
    principalId,
    sessionLease,
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
 * time and the queue drains naturally (DOL-1047).
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
  if (typeof realtime.debounceMs === "number")
    out.debounceMs = realtime.debounceMs;
  if (typeof realtime.maxWaitMs === "number")
    out.maxWaitMs = realtime.maxWaitMs;
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
 * a legitimate runtime case — reject with a safe 429 ClientError.
 * Fabricating an empty successful result would hide real records.
 */
export const DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET = 500;

const DEFAULT_DEBOUNCE_MS = 25;
const DEFAULT_MAX_WAIT_MS = 100;
const DEFAULT_REEVAL_CONCURRENCY = 8;

const EMPTY_EXPAND: readonly ResolvedExpand[] = Object.freeze([]);

export function requirePositiveSafeInteger(
  value: unknown,
  label: string,
): number {
  const parsed =
    typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : value;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0
  ) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export class QuerySubscriptionManager {
  private queries = new Map<string, CachedQuery>();
  private socketQueries = new Map<string, Set<string>>();
  /**
   * socket id → (query hash → in-flight subscribe count).
   *
   * Counts, rather than a Set, are required because concurrent same-hash
   * subscribes share one quota slot. The slot must remain reserved until the
   * final contender settles, even if the contender that created it fails.
   */
  private socketReservations = new Map<string, Map<string, number>>();
  private nextAttachmentGeneration = 0;
  private typeIndex = new Map<string, Set<string>>();
  /**
   * Secondary index from expanded-target-type → cached query hashes.
   * When a `File` row changes, every cached query that expanded
   * `file` (regardless of which parent type) needs a re-eval so the
   * inlined linked row stays fresh. v1 invalidation is naive: any
   * change to the target type wakes every subscriber that expanded
   * it, regardless of projection (see DOL-1093 open questions for
   * the field-aware follow-up).
   */
  private expandTargetIndex = new Map<string, Set<string>>();

  private emitToSocket: EmitToSocket;
  private emitToSockets: EmitToSockets | null;
  private defaultDebounceMs: number;
  private defaultMaxWaitMs: number;
  private reevalSemaphore: Semaphore;
  private maxSubscriptionsPerSocket: number;

  constructor(io: EmitToSocket | IoBackend, opts: ManagerOptions = {}) {
    // Two shapes for backward compatibility. The legacy bare function fans
    // out one emit per subscriber; createApp uses exact-target batch emit.
    if (typeof io === "function") {
      this.emitToSocket = io;
      this.emitToSockets = null;
    } else {
      this.emitToSocket = io.emitToSocket;
      this.emitToSockets = io.emitToSockets ?? null;
    }
    this.defaultDebounceMs = requireNonNegativeSafeInteger(
      opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      "Query subscription debounceMs",
    );
    this.defaultMaxWaitMs = requireNonNegativeSafeInteger(
      opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      "Query subscription maxWaitMs",
    );
    this.reevalSemaphore = new Semaphore(
      requirePositiveSafeInteger(
        opts.reevalConcurrency ?? DEFAULT_REEVAL_CONCURRENCY,
        "Query subscription reevalConcurrency",
      ),
    );
    this.maxSubscriptionsPerSocket = requirePositiveSafeInteger(
      opts.maxSubscriptionsPerSocket ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET,
      "Query subscription maxSubscriptionsPerSocket",
    );
  }

  /** @internal — exposed for diagnostics + tests. */
  get reevalInFlight(): number {
    return this.reevalSemaphore.inFlight;
  }

  // ── Subscribe ──────────────────────────────────────────────────────

  async subscribe(
    opts: SubscriptionOptions,
    extra: SubscribeExtraOptions = {},
  ): Promise<{
    hash: string;
    items: Record<string, any>[];
    subscriptionCreated: boolean;
    attachmentGeneration: number;
    attachmentOwnedByCaller: boolean;
  }> {
    const { socketId, query, steps, isActive, attachmentOwner } = opts;
    const sessionLease = opts.sessionLease ?? socketId;
    if (sessionLease.length === 0) {
      throw new ClientError(
        "A non-empty subscription session lease is required",
      );
    }
    const principal = opts.principal
      ? Object.freeze({ id: opts.principal.id })
      : null;
    const expand = opts.expand ?? EMPTY_EXPAND;
    const orderOptedOut = orderEmissionDisabled(steps);
    // `__modelType` lives on the QueryChain interface as @internal —
    // populated by every chain factory (`Model._query` → `lazyQuery`
    // server-side, the adapter's `query()` factory client-side).
    const modelType = query.__modelType;
    const hash = hashFrom(
      query.exec().toSQL(),
      expand,
      principal?.id ?? null,
      sessionLease,
    );

    // Per-socket cap enforced BEFORE the cache lookup so a socket
    // can't unlock new subscriptions by re-requesting an already-
    // cached hash. The cap is on the socket's distinct-hash set
    // size, not on the cached query's total subscribers — sharing a
    // query across many sockets is fine and intentional.
    const existing = this.socketQueries.get(socketId);
    const alreadySubscribed = existing?.has(hash) ?? false;
    let reservations = this.socketReservations.get(socketId);
    const alreadyReserved = reservations?.has(hash) ?? false;
    let distinctHashes = existing?.size ?? 0;
    if (reservations) {
      for (const reservedHash of reservations.keys()) {
        if (!existing?.has(reservedHash)) distinctHashes++;
      }
    }
    if (
      !alreadySubscribed &&
      !alreadyReserved &&
      distinctHashes >= this.maxSubscriptionsPerSocket
    ) {
      log.warn(
        `subscriptions: per-socket cap ${this.maxSubscriptionsPerSocket} reached for ${modelType}`,
      );
      throw new ClientError("Realtime query subscription limit reached", 429);
    }
    if (!reservations) {
      reservations = new Map();
      this.socketReservations.set(socketId, reservations);
    }
    reservations.set(hash, (reservations.get(hash) ?? 0) + 1);

    try {
      let cached = this.queries.get(hash);
      let rows: Record<string, any>[] | null = null;

      // Drift-poll path: caller asked us to re-execute the cached query
      // against the DB and diff to every subscriber.
      if (cached && extra.force) await this._reeval(cached);

      // A concurrent unsubscribe can remove a cached query while force re-eval
      // is awaiting. A cache miss also lands here. Execute outside the maps,
      // then re-read the winner before committing.
      if (!this.queries.has(hash)) {
        rows = await this._execQuery(query, expand, principal);
      }
      if (this.socketReservations.get(socketId) !== reservations) {
        throw new Error("Socket subscriptions cleared before commit");
      }
      if (isActive && !isActive()) {
        throw new Error("Socket session changed before subscription commit");
      }

      cached = this.queries.get(hash);
      if (!cached) {
        const result = new Map<string, Record<string, any>>();
        for (const row of rows ?? []) {
          const clean = dateSafeClone(row);
          result.set(clean.id, clean);
        }

        const overrides = realtimeOverridesFor(query);
        cached = {
          hash,
          modelType,
          query,
          principal,
          disposed: false,
          expand,
          result,
          subscribers: new Map(),
          emitOrder: !orderOptedOut,
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

        for (const exp of expand) {
          let bucket = this.expandTargetIndex.get(exp.targetType);
          if (!bucket) {
            bucket = new Set();
            this.expandTargetIndex.set(exp.targetType, bucket);
          }
          bucket.add(hash);
        }
      } else if (orderOptedOut) {
        // Honour the most restrictive order preference among sharers.
        cached.emitOrder = false;
      }

      const priorAttachment = cached.subscribers.get(socketId);
      const subscribedAtCommit = priorAttachment !== undefined;
      const attachmentGeneration = ++this.nextAttachmentGeneration;
      const attachmentOwnedByCaller =
        attachmentOwner !== undefined &&
        (!priorAttachment || priorAttachment.owner === attachmentOwner);
      cached.subscribers.set(socketId, {
        generation: attachmentGeneration,
        owner: attachmentOwnedByCaller ? attachmentOwner : null,
      });
      if (!this.socketQueries.has(socketId)) {
        this.socketQueries.set(socketId, new Set());
      }
      this.socketQueries.get(socketId)!.add(hash);

      return {
        hash,
        items: [...cached.result.values()],
        subscriptionCreated: !subscribedAtCommit,
        attachmentGeneration,
        attachmentOwnedByCaller,
      };
    } finally {
      const remaining = (reservations.get(hash) ?? 1) - 1;
      if (remaining > 0) {
        reservations.set(hash, remaining);
      } else {
        reservations.delete(hash);
      }
      if (
        reservations.size === 0 &&
        this.socketReservations.get(socketId) === reservations
      ) {
        this.socketReservations.delete(socketId);
      }
    }
  }

  // ── Unsubscribe ────────────────────────────────────────────────────

  async unsubscribe(socketId: string, hash: string): Promise<void> {
    this._unsubscribe(socketId, hash);
  }

  /**
   * Roll back only the exact attachment created by a failed multi-query
   * operation. A later LIST/resync reuse advances the generation and survives.
   */
  async unsubscribeIfAttachmentCurrent(
    socketId: string,
    hash: string,
    attachmentGeneration: number,
    attachmentOwner?: object,
  ): Promise<void> {
    const cached = this.queries.get(hash);
    const attachment = cached?.subscribers.get(socketId);
    if (attachment?.generation !== attachmentGeneration) {
      return;
    }
    if (attachmentOwner !== undefined && attachment.owner !== attachmentOwner) {
      return;
    }
    this._unsubscribe(socketId, hash);
  }

  /**
   * Relinquish rollback ownership after a batch has fully succeeded. The
   * generation and token checks prevent an older batch from changing a newer
   * attachment.
   */
  commitAttachmentOwner(
    socketId: string,
    hash: string,
    attachmentGeneration: number,
    attachmentOwner: object,
  ): void {
    const attachment = this.queries.get(hash)?.subscribers.get(socketId);
    if (
      attachment?.generation === attachmentGeneration &&
      attachment.owner === attachmentOwner
    ) {
      attachment.owner = null;
    }
  }

  private _unsubscribe(socketId: string, hash: string): void {
    const cached = this.queries.get(hash);
    if (!cached) return;

    cached.subscribers.delete(socketId);
    const socketHashes = this.socketQueries.get(socketId);
    socketHashes?.delete(hash);
    if (socketHashes?.size === 0) this.socketQueries.delete(socketId);

    if (cached.subscribers.size === 0) {
      this._disposeCached(cached);
    }
  }

  async unsubscribeAll(socketId: string): Promise<void> {
    // Detach old in-flight reservations immediately at an authorization
    // boundary. Each subscribe closure still owns its old Map; its identity
    // check in `finally` prevents it from deleting a new session's map.
    this.socketReservations.delete(socketId);
    const hashes = this.socketQueries.get(socketId);
    if (!hashes) return;

    for (const hash of hashes) {
      const cached = this.queries.get(hash);
      if (!cached) continue;
      cached.subscribers.delete(socketId);
      if (cached.subscribers.size === 0) {
        this._disposeCached(cached);
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
    // only projected `file.url`. Trade-off accepted in DOL-1093.
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
    if (cached.disposed) return;
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
    // Bound the parallel DB hits across the whole manager. Without
    // the semaphore, N distinct cached queries all hitting `onModelChange`
    // in the same tick launch N concurrent SELECTs and either queue
    // on the pool or starve unrelated handlers (DOL-1047).
    await this.reevalSemaphore.acquire();
    try {
      if (cached.disposed || cached.subscribers.size === 0) return;
      await this._reeval(cached);
    } catch {
      log.error("subscriptions: re-evaluation failed");
    } finally {
      this.reevalSemaphore.release();
      c.inFlight = false;
    }
    if (!cached.disposed && c.needsFollowup) {
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

  private _disposeCached(cached: CachedQuery): void {
    if (cached.disposed) return;
    this._teardownCoalesce(cached);
    if (this.queries.get(cached.hash) === cached) {
      this.queries.delete(cached.hash);
    }
    this.typeIndex.get(cached.modelType)?.delete(cached.hash);
    for (const exp of cached.expand) {
      this.expandTargetIndex.get(exp.targetType)?.delete(cached.hash);
    }

    cached.disposed = true;
    cached.result.clear();
    cached.subscribers.clear();
    cached.principal = null;
    cached.query = null;
  }

  private async _reeval(cached: CachedQuery): Promise<void> {
    const query = cached.query;
    if (cached.disposed || cached.subscribers.size === 0 || !query) return;

    const rows = await this._execQuery(query, cached.expand, cached.principal);
    if (cached.disposed || cached.subscribers.size === 0) return;
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
    // DOL-1101: queries that opted out via `.orderBy(false)` get NO
    // order envelope, ever. We still emit op-only frames when ops
    // exist; we just never compute or ship the ordered id list.
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
    const currentSubscribers = [...cached.subscribers.keys()];
    if (currentSubscribers.length === 0) return;
    if (this.emitToSockets) {
      this.emitToSockets(currentSubscribers, event, envelope);
    } else {
      for (const socketId of currentSubscribers) {
        this.emitToSocket(socketId, event, envelope);
      }
    }
  }

  // ── Query Execution ────────────────────────────────────────────────

  private async _execQuery(
    query: QueryChain<any>,
    expand: readonly ResolvedExpand[],
    principal: Readonly<{ id: string }> | null,
  ): Promise<Record<string, any>[]> {
    const models = await query.clone().find();
    // `query.find()` returns `Promise<any[]>` (the chain's generic is
    // `any`), but realtime rows must still cross the Model sanitizer. Never
    // fall back to `__data`: an invalid custom sanitizer returning undefined
    // must fail closed rather than expose the raw row.
    const wireRows = await Promise.all(
      models.map(async (m: any) => {
        if (typeof m?.sanitize !== "function") {
          throw new Error("Realtime query row is missing sanitize()");
        }
        const sanitized = await m.sanitize(principal ?? undefined);
        if (
          !sanitized ||
          typeof sanitized !== "object" ||
          Array.isArray(sanitized)
        ) {
          throw new Error("Model sanitize() must return an object");
        }
        return sanitized as Record<string, any>;
      }),
    );

    if (expand.length === 0) return wireRows;

    // Build an ephemeral RefLoader pointed at the adapter's batch
    // entrypoint. This runs OUTSIDE a request scope (re-eval fires
    // on `onModelChange`, which has no AsyncLocalStorage frame), so
    // we can't reuse `getRefLoader()`. The per-reeval loader still
    // collapses every ref-id-per-row into one query per target
    // type via the same microtask batching.
    const adapter = (query as any).__adapter as {
      batchFindByType?: (
        type: string,
        ids: string[],
      ) => Promise<Map<string, any>>;
    } | null;
    if (!adapter?.batchFindByType) return wireRows;
    const loader = new RefLoader((type, ids) =>
      adapter.batchFindByType!(type, ids),
    );
    await hydrateExpansions(wireRows, expand, loader, principal);
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
