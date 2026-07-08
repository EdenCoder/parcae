/**
 * @parcae/model — Model Base Class
 *
 * The instance IS the data store. No Proxy wrapper, no write interception.
 * Writes are one of three explicit primitives:
 *
 *   - save()        → upsert the entire current document. No diff, no
 *                     dirty-tracking. Used for creates and full-document
 *                     writes. Runs the adapter's "save" path (which on
 *                     the backend invokes "save" hooks).
 *
 *   - patch(ops)    → apply RFC 6902 ops locally, then send them. Caller
 *                     knows exactly what changed. Already self-contained,
 *                     already tracks in-flight paths for server-echo
 *                     filtering.
 *
 *   - flush()       → compute the diff between `__serverSnapshot` and the
 *                     current local state, send as patches. Drop-in
 *                     replacement for the old "auto-save-dirty-fields"
 *                     behaviour, but computed on demand rather than
 *                     observed incrementally through a write trap.
 *
 * `__serverSnapshot` is the one piece of new state: a plain object holding
 * the last server-authoritative view of the document. It's set on
 * construction (from the fetch/create payload), refreshed by
 * `SYM_SERVER_MERGE` on server-initiated updates, and reapplied after
 * save() / patch() acks.
 *
 * `"change"` fires from exactly three sites: patch(), flush() (via its
 * inner patch() call), and SYM_SERVER_MERGE. Direct field writes do NOT
 * emit — callers who want to signal UI re-render call flush() (or patch()
 * with explicit ops). `useModel` / `useModelAtomic` subscribe to
 * `"change"`; reference identity across merges is trivially stable
 * because `this` is stable.
 *
 * `patch()` / `flush()` emit synchronously (optimistic UI relies on
 * the immediate update). `SYM_SERVER_MERGE` emits via a microtask-
 * batched queue — multiple per-row merges in a single server frame
 * coalesce into one render commit per instance. See
 * `scheduleChangeEmit` for the batching contract.
 */

import { EventEmitter } from "eventemitter3";
import ShortId from "short-unique-id";
import { applyPatch, compare } from "fast-json-patch";
import { dedupOps } from "./patch";
import {
  CHAINABLE_METHODS,
  type ModelAdapter,
  type ModelConstructor,
  type QueryChain,
  type SchemaDefinition,
  type PatchOp,
} from "./adapters/types";

// ─── ID Generation ───────────────────────────────────────────────────────────

const uid = new ShortId({ length: 20 });

export function generateId(): string {
  return uid.rnd();
}

// ─── Symbols for internal state (never collide with data properties) ─────────

const SYM_ADAPTER = Symbol("parcae:adapter");
/** Full RFC 6902 paths currently in-flight via patch(). Used by SYM_SERVER_MERGE and useQuery to skip server echoes for sub-paths the client just wrote. */
const SYM_PATCHING = Symbol("parcae:patching");
/** The last-known server-authoritative snapshot of this document. Refreshed on construction, save/patch ack, and SYM_SERVER_MERGE. flush() diffs against this. */
const SYM_SNAPSHOT = Symbol("parcae:serverSnapshot");
/** Temporary staging for constructor-provided data until subclass field initializers finish running. Consumed and deleted by the static factories via _apply(). */
const SYM_PENDING_DATA = Symbol("parcae:pendingData");
/** The currently executing flush() promise, if any. Used to serialize concurrent flush() calls. */
const SYM_FLUSH_INFLIGHT = Symbol("parcae:flushInflight");
/** A queued trailing flush() promise that will run after the current in-flight finishes. Multiple concurrent callers during an in-flight share this one. */
const SYM_FLUSH_TRAILING = Symbol("parcae:flushTrailing");

/**
 * Atomically merge server-authoritative data onto this instance.
 *
 * Skips keys with pending local writes (SYM_PATCHING), deletes keys the
 * server no longer has, refreshes `__serverSnapshot`, and emits
 * `"change"` iff something actually changed. The emit is **batched**
 * via `scheduleChangeEmit`: multiple merges within one synchronous
 * tick coalesce into a single per-instance notification on the next
 * microtask. This is the hot path for `useQuery` list re-syncs;
 * synchronous emit there caused a render-storm freeze on large lists
 * (~500 rows × N subscribers each).
 *
 * Defined as a plain method — `this` identity is stable, so there's no
 * need for the old get-trap closure indirection.
 */
export const SYM_SERVER_MERGE = Symbol("parcae:serverMerge");

/**
 * Monotonic version counter bumped on every `"change"` emit. Exported so
 * `useModel(model)` / `useModelAtomic(model, path)` can use it as a
 * `useSyncExternalStore` snapshot.
 */
export const SYM_VERSION = Symbol("parcae:version");

// ─── Batched `"change"` emission for server merges ───────────────────────────
//
// `SYM_SERVER_MERGE` is the hot path for server-driven updates: every
// row in a `useQuery` list re-sync runs through it once, and each call
// historically fired `this.emit("change")` synchronously. With a list
// of N rows updating in one server frame (e.g. `expand("file")`
// resolving 500 linked rows on initial load) that's N synchronous
// emits in a tight loop — each fanning out to every
// `useModelAtomic` / `useModel` listener subscribed to that row.
// For dollhouse this is the difference between an editor that opens
// in <1s and one that freezes for 10+s while React serially commits
// hundreds of subscriber wakes.
//
// Buffer per-instance: each merge that actually changed something
// inserts itself into the queue and schedules a microtask flush.
// Repeat merges within the same tick coalesce (Set semantics). The
// microtask drains the queue and emits `"change"` on each instance
// once. React's `useSyncExternalStore`-backed hooks (`useModel`,
// `useModelAtomic`) read the live `SYM_VERSION` on notify so the
// batch's per-instance scalar values are already current.
//
// Other emit sites are unaffected: `patch()` keeps its synchronous
// emit (user-initiated, one model, optimistic UI relies on
// immediate update), and `remove` / `patching` / `saving` aren't
// batched either.
const pendingChangeEmits = new Set<Model>();
let flushScheduled = false;

function flushPendingChangeEmits(): void {
  flushScheduled = false;
  if (pendingChangeEmits.size === 0) return;
  // Snapshot before iterating: a listener may trigger another merge
  // (e.g. derived store mirror) and re-enqueue into the live Set.
  // Drain into a local array so re-entry queues are picked up by
  // the next microtask, not this one.
  const drain = Array.from(pendingChangeEmits);
  pendingChangeEmits.clear();
  for (const model of drain) {
    try {
      model.emit("change");
    } catch (err) {
      // Listeners must not break sibling listeners. Surface but
      // keep draining.
      console.error("[parcae] change listener threw", err);
    }
  }
}

/**
 * Drain the deferred `"change"` emit queue synchronously.
 *
 * `SYM_SERVER_MERGE` schedules its `change` emit on the microtask
 * queue (see the batcher above). Most callers can rely on the
 * implicit drain — React's `useSyncExternalStore` consumes the
 * notification when the microtask runs, before the next render.
 *
 * Synchronous callers that need to observe the merge result
 * immediately (tests, server-side coordinators) use
 * `flushChangeEmits()` to force a drain right now without waiting
 * for the microtask scheduler.
 *
 * Safe to call repeatedly; a no-op when the queue is empty.
 */
export function flushChangeEmits(): void {
  flushPendingChangeEmits();
}

function scheduleChangeEmit(model: Model): void {
  pendingChangeEmits.add(model);
  if (!flushScheduled) {
    flushScheduled = true;
    queueMicrotask(flushPendingChangeEmits);
  }
}

// ─── Keys that should NOT be treated as data ─────────────────────────────────

const INSTANCE_METHODS = new Set([
  "save",
  "patch",
  "flush",
  "remove",
  "refresh",
  "sanitize",
  "toJSON",
  "get",
  "set",
  "constructor",
  "__savingCount",
  "__isNew",
]);

const EVENTEMITTER_KEYS = new Set([
  "emit",
  "on",
  "off",
  "once",
  "removeListener",
  "removeAllListeners",
  "listeners",
  "listenerCount",
  "addListener",
  "eventNames",
  "_events",
  "_eventsCount",
]);

/** Properties that are part of the data but set through fixed code paths. */
const SYSTEM_DATA_KEYS = new Set([
  "id",
  "type",
  "createdAt",
  "updatedAt",
  "tmp",
]);

// ─── Lazy Query Chain ────────────────────────────────────────────────────────
// Records query steps without needing an adapter. The adapter is resolved
// lazily when a terminal method (.find(), .first(), .count()) is called.
// This allows building queries before Model.use() is called (e.g. in React
// component bodies before ParcaeProvider mounts).

/**
 * Run `_apply()` on a freshly-constructed instance. Centralised so the
 * `instance as any` cast lives in exactly one place rather than every
 * static factory.
 */
function applyInstance(instance: any): void {
  instance._apply();
}

/** Stamp the `__isNew` flag. Same centralisation rationale. */
function markNew(instance: any, value: boolean): void {
  instance.__isNew = value;
}

export function serializeLazyQueryArgs(args: any[]): any[] {
  return args.map((arg) => {
    if (typeof arg !== "function") return arg;
    const nested: any[] = [];
    const recorder: any = new Proxy(
      {},
      {
        get: (_target, method: string | symbol) =>
          (...innerArgs: any[]) => {
            if (typeof method === "string") {
              nested.push({
                method,
                args: serializeLazyQueryArgs(innerArgs),
              });
            }
            return recorder;
          },
      },
    );
    try {
      arg(recorder);
    } catch {
      return { __nested: "__opaque__" };
    }
    return { __nested: nested };
  });
}

function lazyQuery<T>(
  modelClass: ModelConstructor<T>,
  steps: any[] = [],
  keySteps: any[] = [],
): QueryChain<T> {
  const chain: any = {};

  for (const method of CHAINABLE_METHODS) {
    chain[method] = (...args: any[]) =>
      lazyQuery(
        modelClass,
        [...steps, { method, args }],
        [...keySteps, { method, args: serializeLazyQueryArgs(args) }],
      );
  }

  const resolve = async (): Promise<QueryChain<T>> => {
    const adapter = Model.hasAdapter()
      ? Model.getAdapter()
      : await Model.waitForAdapter();
    let q = adapter.query(modelClass);
    for (const step of steps) {
      q = (q as any)[step.method](...step.args);
    }
    return q;
  };

  chain.find = async () => (await resolve()).find();
  chain.first = async () => (await resolve()).first();
  chain.count = async () => (await resolve()).count();
  chain.sum = async (column: string) => (await resolve()).sum(column);

  chain.__steps = keySteps;
  chain.__modelType = modelClass.type;
  chain.__modelClass = modelClass;
  chain.__adapter = null;

  return chain as QueryChain<T>;
}

// ─── Patch helpers ──────────────────────────────────────────────────────────

/**
 * RFC 6901 array-index segment: numeric string (`"0"`, `"12"`) or
 * the append-marker `"-"`. When the NEXT path segment after a
 * missing intermediate is one of these, the intermediate must be an
 * array, not an object — otherwise `applyPatch`'s array-add /
 * array-replace branch can't do its splice / index assignment, and
 * a downstream `for…of` would crash with "object is not iterable".
 */
export function isArrayIndexSegment(seg: string | undefined): boolean {
  return seg === "-" || (seg !== undefined && /^\d+$/.test(seg));
}

/**
 * `fast-json-patch` doesn't auto-vivify parent objects. Walk every op's
 * path and ensure intermediate segments exist so applyPatch doesn't
 * blow up on a missing parent.
 *
 * Vivification shape is decided by looking at the NEXT path segment:
 * a numeric index (or `-`) means the intermediate is an array; any
 * other key means it's a plain object. Without the array branch,
 * patches like `replace /blocks/<id>/shots/0/panel` on a block with
 * no prior `shots` field would create `block.shots = {}` and then
 * set `block.shots["0"]…` — leaving a `{ "0": {…} }` shape that
 * looks like an array but throws `object is not iterable` on the
 * very next `for (const s of block.shots)`.
 */
export function ensureIntermediates(
  doc: Record<string, any>,
  ops: readonly { path: string }[],
): void {
  for (const { path } of ops) {
    const segments = path.split("/").filter(Boolean);
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

/**
 * Produce a JSON-safe deep copy of `value` where `Date` instances are
 * serialised to ISO strings and arrays/objects are recursively cloned.
 *
 * Used by `_doFlush()` to feed `fast-json-patch.compare()` a Date-free
 * structure. Without this coercion, `compare()` walks each `Date` as a
 * string-iterable and emits ~24 char-level `add` ops per Date field
 * instead of detecting equality. One recursive walk per side drops
 * two string-allocation passes per flush.
 *
 * Semantics match `JSON.parse(JSON.stringify(value))`'s own-enumerable
 * traversal (we use `Object.keys` not `for...in` so prototype-chain
 * properties stay absent from the clone, same as the JSON round-trip).
 */
export function dateSafeClone(value: any): any {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = dateSafeClone(value[i]);
    }
    return out;
  }
  if (typeof value === "object") {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      out[key] = dateSafeClone((value as any)[key]);
    }
    return out;
  }
  return value;
}

/** Return the set of top-level keys touched by a batch of ops. */
function topLevelKeys(ops: readonly PatchOp[]): Set<string> {
  const keys = new Set<string>();
  for (const op of ops) {
    const top = op.path.split("/")[1];
    if (top) keys.add(top);
    if (op.op === "copy" || op.op === "move") {
      const fromTop = op.from.split("/")[1];
      if (fromTop) keys.add(fromTop);
    }
  }
  return keys;
}

// ─── Ref Proxy Cache ─────────────────────────────────────────────────────────
//
// Module-level so the periodic sweep can clear expired entries without
// needing access to the class internals. Entries are written on every
// findById completion and every .expand() hydration, and evicted either
// on the next read of the same key (lazy) or by the sweep below (bounded).

const __refCache = new Map<string, { value: any; expires: number }>();
const REF_CACHE_TTL = 30_000;

if (typeof setInterval === "function") {
  const _sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of __refCache)
      if (v.expires < now) __refCache.delete(k);
  }, 60_000);
  if (typeof _sweep === "object" && _sweep !== null && "unref" in _sweep) {
    (_sweep as any).unref();
  }
}

// ─── Model Class ─────────────────────────────────────────────────────────────

export class Model extends EventEmitter {
  // ── Instance data — declared so TS knows about them; set in _apply() ─

  declare id: string;
  declare createdAt: Date | string;
  declare updatedAt: Date | string;
  /** Temporary client-side ID for optimistic matching. Stored in JSONB overflow. */
  declare tmp?: string;

  /** Number of in-flight save/patch operations. 0 = idle. Consumed by useSaving. */
  __savingCount: number = 0;

  /** True if this instance has never been persisted (fresh Model.create()). */
  __isNew: boolean = false;

  // ── Symbol-keyed slots — declared here so TypeScript sees them on the
  // class type regardless of how the module is resolved (package import,
  // tsconfig path alias, or relative import). A `declare module "./Model"`
  // augmentation does not propagate when the consumer resolves the module
  // under a different specifier (e.g. `@parcae/model`).
  declare [SYM_ADAPTER]: ModelAdapter;
  declare [SYM_PATCHING]: Set<string>;
  declare [SYM_SNAPSHOT]: Record<string, any>;
  declare [SYM_PENDING_DATA]: Record<string, any> | undefined;
  declare [SYM_FLUSH_INFLIGHT]: Promise<void> | null | undefined;
  declare [SYM_FLUSH_TRAILING]: Promise<void> | null | undefined;
  declare [SYM_VERSION]: number;

  // ── Static ─────────────────────────────────────────────────────────

  /**
   * Discriminator for this model class. Singular, lowercase, used for:
   *   - the table name (`pluralize(type)` → `pluralize("post")` → `"posts"`)
   *   - the auto-CRUD path (`/v1/{type}s`)
   *   - the response shape key (`{ posts: [...] }`)
   *   - the `type` field included in `sanitize()` / `toJSON()`
   *     projections so polymorphic client code can route on it
   *
   * Lives ONLY on the constructor — there's no instance field by the
   * same name. Read it from the static (`Post.type`) or, given an
   * instance, via `(post.constructor as typeof Model).type`. The
   * framework's projections do the static read internally, so client
   * payloads still carry a `type` key as before.
   */
  static type: string = "";
  static path?: string;
  static scope?: {
    read?: (ctx: any) => any;
    create?: (ctx: any) => any;
    update?: (ctx: any) => any;
    delete?: (ctx: any) => any;
    patch?: (ctx: any) => any;
  };
  static indexes?: (string | string[])[];
  static searchFields?: string[];
  static managed: boolean = true;
  /**
   * Field-level write protection. Listed columns are stripped from
   * client request bodies before they're applied to the model in the
   * auto-CRUD `POST` / `PUT` / `PATCH` routes. The framework hardcodes
   * `id` / `createdAt` / `updatedAt` / `type` as always-protected on top
   * of this list.
   *
   * Use for:
   *   - Counter columns the framework or hooks own (`sceneCount`,
   *     `viewCount`, `oCount`, …).
   *   - Ownership refs that scope-update can't re-enforce — without
   *     this, a client with update access can reassign the owning
   *     `user` to a different account.
   *   - State-machine fields that should only mutate through explicit
   *     server-side flows (`organized`, `corrupt`, `generatingAt`).
   *
   * Server-side code can still write these fields directly via
   * `model.x = …; await model.save()` — `readonly` only restricts the
   * HTTP-driven entry points.
   *
   * Default is empty (no extra restrictions) so existing models stay
   * backward-compatible.
   */
  static readonly readonlyFields: readonly string[] = [];
  /**
   * Field-level read protection for the default `sanitize()`. Listed
   * columns are stripped from the response shape so a column like
   * `passwordHash` / `apiKey` / `inviteToken` doesn't leak through
   * the auto-CRUD GET endpoints.
   *
   * Subclasses that override `sanitize()` directly bypass this list —
   * they get full control over the shape. This is the safety net for
   * the default path.
   *
   * Default is empty (no extra restrictions) so existing models stay
   * backward-compatible. Encourage opting-in for any model with
   * sensitive columns.
   */
  static readonly privateFields: readonly string[] = [];
  /** @internal */
  static __schema?: SchemaDefinition;

  // Adapter lives on globalThis so it works across multiple copies of @parcae/model
  // (pnpm can install multiple versions — they all need to share the same adapter)
  private static get __adapter(): ModelAdapter | null {
    return (globalThis as any).__parcae_adapter ?? null;
  }
  private static set __adapter(v: ModelAdapter | null) {
    (globalThis as any).__parcae_adapter = v;
  }
  private static get __pendingAdapter(): Promise<ModelAdapter> | null {
    return (globalThis as any).__parcae_pending ?? null;
  }
  private static set __pendingAdapter(v: Promise<ModelAdapter> | null) {
    (globalThis as any).__parcae_pending = v;
  }
  private static get __resolveAdapter():
    | ((adapter: ModelAdapter) => void)
    | null {
    return (globalThis as any).__parcae_resolve ?? null;
  }
  private static set __resolveAdapter(
    v: ((adapter: ModelAdapter) => void) | null,
  ) {
    (globalThis as any).__parcae_resolve = v;
  }

  static use(adapter: ModelAdapter): void {
    Model.__adapter = adapter;
    if (Model.__resolveAdapter) {
      Model.__resolveAdapter(adapter);
      Model.__resolveAdapter = null;
      Model.__pendingAdapter = null;
    }
  }

  static getAdapter(): ModelAdapter {
    if (!Model.__adapter) {
      throw new Error(
        "No adapter set. Call Model.use(adapter) before using models.",
      );
    }
    return Model.__adapter;
  }

  static hasAdapter(): boolean {
    return Model.__adapter !== null;
  }

  static waitForAdapter(): Promise<ModelAdapter> {
    if (Model.__adapter) return Promise.resolve(Model.__adapter);
    if (!Model.__pendingAdapter) {
      Model.__pendingAdapter = new Promise<ModelAdapter>((resolve) => {
        Model.__resolveAdapter = resolve;
      });
    }
    return Model.__pendingAdapter;
  }

  // ── Static Query Methods ───────────────────────────────────────────
  //
  // Every method below uses `this: ModelConstructor<T>` so the typing
  // closes via the call shape: `Scene.where(...)` binds T = Scene from
  // `typeof Scene satisfies ModelConstructor<Scene>`. The returned
  // chain wraps T in `WithRefs<T>` to surface the `$`-prefixed ref
  // accessors that `_apply()` installs at runtime. The single cast at
  // the end of each body bridges the `QueryChain<T>` lazyQuery returns
  // with the wider `QueryChain<WithRefs<T>>` the contract advertises;
  // safe because `WithRefs<T>` is `T` plus extra fields.

  /**
   * Create a new, unsaved Model instance. Data provided here wins over
   * any field-initializer defaults on the subclass (because _apply() runs
   * AFTER the subclass's field initializers have fired).
   */
  static create<T extends Model>(
    this: ModelConstructor<T>,
    data?: Record<string, any>,
  ): WithRefs<T> {
    const instance = new this(Model.getAdapter(), data);
    applyInstance(instance);
    markNew(instance, true);
    return instance as WithRefs<T>;
  }

  /**
   * Hydrate an instance from server/DB data. Used by adapters — the
   * result is NOT marked `__isNew`, and `__serverSnapshot` is seeded
   * from `data` so flush() knows there's nothing to send initially.
   *
   * Returns `T` (not `WithRefs<T>`) because adapters are type-erased at
   * the call site — they work generically across model classes.
   */
  static hydrate<T extends Model>(
    this: ModelConstructor<T>,
    adapter: ModelAdapter,
    data: Record<string, any>,
  ): T {
    const instance = new this(adapter, data);
    applyInstance(instance);
    markNew(instance, false);
    return instance;
  }

  static findById<T extends Model>(
    this: ModelConstructor<T>,
    id: string,
  ): Promise<WithRefs<T> | null> {
    return Model.getAdapter().findById(this, id) as Promise<WithRefs<T> | null>;
  }

  static where<T extends Model>(
    this: ModelConstructor<T>,
    ...args: any[]
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this).where(...args) as QueryChain<WithRefs<T>>;
  }

  static whereRaw<T extends Model>(
    this: ModelConstructor<T>,
    query: string,
    ...bindings: any[]
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this).whereRaw(query, ...bindings) as QueryChain<
      WithRefs<T>
    >;
  }

  static whereIn<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
    values: any[],
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this).whereIn(column, values) as QueryChain<WithRefs<T>>;
  }

  static whereNot<T extends Model>(
    this: ModelConstructor<T>,
    ...args: any[]
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this).whereNot(...args) as QueryChain<WithRefs<T>>;
  }

  static whereNotIn<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
    values: any[],
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this).whereNotIn(column, values) as QueryChain<
      WithRefs<T>
    >;
  }

  static whereNull<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this).whereNull(column) as QueryChain<WithRefs<T>>;
  }

  static whereNotNull<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this).whereNotNull(column) as QueryChain<WithRefs<T>>;
  }

  static select<T extends Model>(
    this: ModelConstructor<T>,
    ...columns: string[]
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this).select(...columns) as QueryChain<WithRefs<T>>;
  }

  static count<T extends Model>(this: ModelConstructor<T>): Promise<number> {
    return lazyQuery(this).count();
  }

  static sum<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
  ): Promise<number> {
    return lazyQuery(this).sum(column);
  }

  static search<T extends Model>(
    this: ModelConstructor<T>,
    term: string,
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this).search(term) as QueryChain<WithRefs<T>>;
  }

  // ── Constructor ────────────────────────────────────────────────────
  //
  // The constructor does NOT apply `data` — that's deferred to `_apply()`
  // because ES2022 class field initializers in the subclass run AFTER
  // super() returns and would clobber anything set here. The static
  // factories (`create` / `hydrate`) call `_apply()` after the full
  // ctor chain (including subclass field initializers) has finished.
  //
  // Calling `new Post(adapter, data)` directly leaves the instance in a
  // half-initialized state; use `Post.create()` / `Post.hydrate()` or
  // the adapter instead.

  constructor(adapter: ModelAdapter, data?: Record<string, any>) {
    super();
    this[SYM_ADAPTER] = adapter;
    this[SYM_PATCHING] = new Set<string>();
    this[SYM_SNAPSHOT] = {};
    (this as any)[SYM_VERSION] = 0;
    if (data) this[SYM_PENDING_DATA] = data;
  }

  /**
   * Apply staged constructor data on top of subclass field-initializer
   * defaults, install ref-field accessors from the schema, and seed
   * `__serverSnapshot`. Called exactly once by the static factories.
   */
  private _apply(): void {
    const data = this[SYM_PENDING_DATA] ?? {};
    delete this[SYM_PENDING_DATA];

    // System fields — always set, even when `data` is empty, so a new
    // instance always has a stable id / timestamps. `type` is NOT set
    // on the instance: it's already on the constructor as a `static
    // type`, so every read just goes through `this.constructor.type`.
    // Storing it twice burns one field per instance (and one key per
    // serialised payload) for no benefit.
    const nowIso = new Date().toISOString();
    (this as any).id = data.id ?? generateId();
    (this as any).createdAt = data.createdAt ?? nowIso;
    (this as any).updatedAt = data.updatedAt ?? nowIso;
    if (data.tmp !== undefined) (this as any).tmp = data.tmp;

    // Identify ref fields up front. We install their getter/setter
    // accessors BEFORE writing non-ref user data so the ref slots
    // never go through a data-property phase that would have to be
    // converted (with a hidden-class transition) on the way out.
    // Subclass field initializers like `author: Author | null = null`
    // may have already written a data property — `defineProperty`
    // overrides cleanly, so we still avoid the deopt-inducing
    // `delete + defineProperty` pattern of the previous design.
    const schema = (this.constructor as typeof Model).__schema;
    const refTargets = new Map<string, ModelConstructor>();
    if (schema) {
      for (const [field, col] of Object.entries(schema)) {
        if (
          typeof col === "object" &&
          col !== null &&
          "kind" in col &&
          col.kind === "ref"
        ) {
          refTargets.set(field, col.target);
        }
      }
    }
    for (const [field, target] of refTargets) {
      // Seed the closure's raw-id slot from whatever the caller passed
      // in. Three shapes:
      //   - Model instance     — use its id as raw; instance is already
      //                          a Model, no pre-hydration needed.
      //   - Inline ref object  — wire payload from `.expand("file")` /
      //                          `.expand("file.url")`. Hydrate the
      //                          object into a target-class instance
      //                          and pre-populate the ref proxy so
      //                          consumers don't trigger a Suspense
      //                          throw on first access.
      //   - String id / null   — bare raw id (or no value). Lazy load
      //                          on first access via `_createRefProxy`.
      const incoming = data[field] ?? (this as any)[field];
      let raw: string | null;
      let prehydrated: Model | null = null;
      if (incoming instanceof Model) {
        raw = (incoming as any).id ?? null;
      } else if (
        incoming &&
        typeof incoming === "object" &&
        typeof (incoming as Record<string, any>).id === "string"
      ) {
        // Inline expanded ref. Hydrate via the target's `.hydrate(...)`
        // factory so the produced instance has the same shape as one
        // returned by `findById` — including its own ref-field
        // accessors and __serverSnapshot, so a subsequent edit on the
        // linked row diffs / saves cleanly.
        //
        // `target` here is the schema entry's `target` constructor —
        // when the schema was built from ts-morph (`schema/resolver.ts`)
        // this may be a stub with just `{ type }`. The backend's
        // schema generator (`schema/generate.ts:200-205`) and
        // BackendAdapter's `_models` lookup (model.ts:359) both
        // resolve it back to a real constructor before any hydrate
        // runs server-side; the runtime `_apply` path here only
        // executes on already-resolved schemas (model bodies that
        // direct-imported their ref targets). The `hydrate`
        // type-guard below is the safety net for the stub case.
        raw = (incoming as Record<string, any>).id as string;
        if (typeof (target as any).hydrate === "function") {
          prehydrated = (target as any).hydrate(
            this[SYM_ADAPTER],
            incoming,
          ) as Model;
        }
      } else if (typeof incoming === "string") {
        raw = incoming || null;
      } else {
        // Anything else (object without id, number, Date, etc.) is
        // not a usable ref payload. Treat it as null so the accessor
        // returns null and a downstream read can't synthesise a
        // garbage findById call against a stringified non-id.
        raw = null;
      }
      this._installRefField(field, target, raw, prehydrated);
    }

    // Apply provided non-system, non-ref data. These OVERWRITE subclass
    // field defaults because we're running after the subclass's field
    // initializers finished. `type` is in SYSTEM_DATA_KEYS so old
    // payloads (e.g. a JSON snapshot from before the field was
    // dropped) don't accidentally write a stale type onto the
    // instance. Ref fields are skipped — their values were already
    // consumed into the accessor closures above.
    for (const [key, value] of Object.entries(data)) {
      if (SYSTEM_DATA_KEYS.has(key)) continue;
      if (refTargets.has(key)) continue;
      (this as any)[key] = value;
    }

    // Seed the server snapshot from the fully-applied state. For a
    // fresh create() the server doesn't actually know about this
    // record yet (snapshot represents "nothing persisted"), but
    // __isNew routes flush() → save() in that case, so the snapshot
    // contents don't matter until after the first save ack refreshes
    // it. For hydrate() the snapshot correctly mirrors the server.
    this[SYM_SNAPSHOT] = structuredClone(this.__data);
  }

  /**
   * Replace the plain `post.author` / `post.$author` pair with an
   * accessor pair driven by a closed-over `raw` id slot.
   *
   *   post.author            → lazy-loading Model proxy (memoized per raw id)
   *   post.author = user     → stores user.id, invalidates cached proxy
   *   post.author = "u_abc"  → stores "u_abc", invalidates cached proxy
   *   post.$author           → "u_abc" (raw id, no load)
   *   post.$author = "u_xyz" → overwrites raw id, invalidates cached proxy
   *
   * No `delete` of the pre-existing data property — `Object.defineProperty`
   * overrides cleanly without forcing V8 into dictionary mode. The
   * caller in `_apply()` also tries to install accessors BEFORE writing
   * non-ref user data, so the most common path (no subclass field
   * initializer with `= null` default) goes through one hidden-class
   * transition per ref instead of three.
 *
 * `prehydrated` lets the caller pre-populate the ref proxy with a
 * fully-loaded target Model — the `.expand("file")` path uses it
 * to embed the linked row inline so consumers don't
   * Suspense-throw on first access. The pre-population mints a
   * fresh proxy (bypassing the per-id cache) so a prior lazy proxy
   * holding `loaded: null` doesn't shadow the freshly-known row.
   * On any subsequent reassignment the cached proxy is cleared and
   * the lazy path resumes (correct: the new ref id may not have
   * been expanded).
   */
  private _installRefField(
    field: string,
    targetClass: ModelConstructor,
    initialRaw: string | null,
    prehydrated: Model | null = null,
  ): void {
    let raw: string | null = initialRaw;
    // Per-instance proxy memoization. The same `raw` id returns the
    // same Proxy reference across reads, so `<UserCard user={post.author}>`
    // rendered at 60 fps doesn't allocate a fresh Proxy per frame.
    let cachedProxy: any =
      prehydrated && raw
        ? this._createPrehydratedRefProxy(targetClass, raw, prehydrated)
        : null;
    let cachedRaw: string | null = cachedProxy ? raw : null;
    const self = this;

    const invalidate = (): void => {
      if (raw !== cachedRaw) cachedProxy = null;
    };

    Object.defineProperty(this, field, {
      configurable: true,
      enumerable: true,
      get() {
        if (!raw) return null;
        if (cachedProxy && cachedRaw === raw) return cachedProxy;
        cachedProxy = self._createRefProxy(targetClass, raw);
        cachedRaw = raw;
        return cachedProxy;
      },
      set(value: Model | string | null | undefined) {
        raw =
          value instanceof Model
            ? ((value as any).id ?? null)
            : (value ?? null);
        invalidate();
      },
    });

    Object.defineProperty(this, `$${field}`, {
      configurable: true,
      // Excluded from Object.keys so __data / serializers don't see it —
      // the ref field itself already serializes to the raw id via the
      // `__data` getter's schema lookup.
      enumerable: false,
      get() {
        return raw;
      },
      set(v: string | null | undefined) {
        raw = v ?? null;
        invalidate();
      },
    });
  }

  // ── Data Access (for adapters / serialization) ──────────────────────

  /**
   * Plain-object snapshot of this instance's data. Filters out methods,
   * EventEmitter internals, underscore-prefixed fields, and `$field`
   * accessors. Ref fields serialize to their raw id.
   */
  get __data(): Record<string, any> {
    const schema = (this.constructor as typeof Model).__schema;
    const data: Record<string, any> = {};
    for (const key of Object.keys(this)) {
      if (EVENTEMITTER_KEYS.has(key)) continue;
      if (INSTANCE_METHODS.has(key)) continue;
      if (key.startsWith("_")) continue;
      if (key.startsWith("$")) continue;
      const col = schema?.[key];
      if (
        col &&
        typeof col === "object" &&
        "kind" in col &&
        col.kind === "ref"
      ) {
        // Read the raw id directly; the public getter would return a
        // Model proxy which isn't serializable.
        data[key] = (this as any)[`$${key}`];
      } else {
        data[key] = (this as any)[key];
      }
    }
    return data;
  }

  set __data(data: Record<string, any>) {
    for (const [key, value] of Object.entries(data)) {
      (this as any)[key] = value;
    }
  }

  /** @internal — full RFC 6902 paths currently in-flight via patch() */
  get __patchingPaths(): ReadonlySet<string> {
    return this[SYM_PATCHING];
  }

  /** @internal — last server-authoritative view; what flush() diffs against */
  get __serverSnapshot(): Readonly<Record<string, any>> {
    return this[SYM_SNAPSHOT];
  }

  // ── Dot-path Accessors ──────────────────────────────────────────────

  /**
   * Read a nested field by dot-path. Pure read — no I/O, no events.
   *
   *   project.get("blocks.abc.image.url")
   */
  get<V = unknown>(path: string): V | undefined {
    if (!path) return undefined;
    const parts = path.split(".");
    let cur: any = this;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur as V;
  }

  /**
   * Write a nested field by dot-path. Pure write — does NOT emit
   * `"change"` and does NOT send to the server. Call `.flush()` (or an
   * explicit `.patch([...])`) to persist. Missing intermediate objects
   * are auto-created.
   *
   *   project.set("blocks.abc.image.url", "https://...");
   *   await project.flush();
   */
  set(path: string, value: unknown): void {
    if (!path) return;
    const parts = path.split(".");
    if (parts.length === 1) {
      (this as any)[parts[0]!] = value;
      return;
    }
    let cur: any = this;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]!;
      if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]!] = value;
  }

  // ── Persistence ──────────────────────────────────────────────────────

  /**
   * Upsert the entire current document to the server. No diffing, no
   * dirty-tracking — the adapter receives the whole model and writes
   * it.
   *
   * Runs the adapter's "save" pipeline (on the backend: "create" /
   * "save" hooks, full INSERT ... ON CONFLICT MERGE).
   */
  async save(): Promise<void> {
    (this as any).updatedAt = new Date().toISOString();
    this.__savingCount++;
    this.emit("saving", this);
    this.emit("__saving", this.__savingCount);
    try {
      await this[SYM_ADAPTER].save(this);
      this.__isNew = false;
      // The server now holds what we just sent. Refresh the snapshot
      // from the post-write local state so flush() starts from zero.
      this[SYM_SNAPSHOT] = structuredClone(this.__data);
      this.emit("saved", this);
    } finally {
      this.__savingCount = Math.max(0, this.__savingCount - 1);
      this.emit("__saving", this.__savingCount);
    }
  }

  /**
   * Apply a batch of RFC 6902 ops locally (optimistic) and send them to
   * the server. Emits `"change"` synchronously before the server
   * round-trip so UI updates immediately.
   *
   * In-flight op paths are recorded in `__patchingPaths` so the
   * subscription layer can skip echoes of its own writes for the
   * specific sub-paths still in flight.
   */
  async patch(rawOps: PatchOp[]): Promise<void> {
    if (rawOps.length === 0) return;
    // Normalize: drop ops whose path lives UNDER another `remove`
    // op in the same batch. Without this, fast-json-patch crashes
    // on the sub-path op when its parent has just been removed.
    // Callers can freely compose helpers — the framework keeps the
    // batch consistent. See `patch.ts:dedupOps` for the contract.
    const ops = dedupOps(rawOps);
    if (ops.length === 0) return;

    const paths = new Set<string>();
    for (const op of ops) paths.add(op.path);
    for (const p of paths) this[SYM_PATCHING].add(p);

    this.__savingCount++;
    this.emit("patching", this);
    this.emit("__saving", this.__savingCount);

    try {
      // Apply locally on a plain-object snapshot (fast-json-patch
      // mutates in place), then copy the touched top-level keys back
      // onto `this`. We avoid applyPatch'ing `this` directly because
      // the instance carries methods / ref accessors / EE internals
      // that would confuse the walker.
      const snap = this.__data;
      ensureIntermediates(snap, ops);
      applyPatch(snap, ops, false, true);
      for (const key of topLevelKeys(ops)) {
        (this as any)[key] = snap[key];
      }

      (this as any)[SYM_VERSION] = (this as any)[SYM_VERSION] + 1;
      this.emit("change");

      await this[SYM_ADAPTER].patch(this, ops);

      // Replay ops onto the snapshot so flush() won't re-emit them.
      //
      // We mutate the existing snapshot in place rather than cloning.
      // `SYM_SNAPSHOT` is Symbol-keyed and only exposed
      // via the `__serverSnapshot` getter that's typed `Readonly` —
      // no external consumer can hold a reference that needs the
      // pre-patch view. On a 500KB Scenecode project the old
      // structuredClone was 3–5 ms of main-thread CPU per patch;
      // mutating in place reclaims that.
      const snapshot = this[SYM_SNAPSHOT];
      ensureIntermediates(snapshot, ops);
      applyPatch(snapshot, ops, false, true);

      this.emit("patched", this);
    } finally {
      for (const p of paths) this[SYM_PATCHING].delete(p);
      this.__savingCount = Math.max(0, this.__savingCount - 1);
      this.emit("__saving", this.__savingCount);
    }
  }

  /**
   * Diff `__serverSnapshot` against the current local state, send the
   * delta as a patch. Drop-in replacement for the old "just save
   * whatever I changed" flow — but computed explicitly on demand rather
   * than observed through a write trap.
   *
   * For a still-new instance (no server-side record yet), this routes
   * to `save()` because a PATCH to a nonexistent id would 404.
   *
   * No-op when the diff is empty.
   *
   * ## Self-serializing
   *
   * Concurrent `flush()` calls coalesce into at most two round-trips
   * per burst:
   *
   *   - The first call starts immediately (leading edge).
   *   - Further calls while the first is in-flight return a shared
   *     "trailing" promise that chains after the in-flight finishes
   *     and captures any changes made during that window. All
   *     trailing callers resolve when the trailing flush completes.
   *
   * This lets streaming call sites fire `msg.flush()` per delta
   * (push the promise into an array, `await Promise.all(...)` at the
   * end) without hand-rolling their own debounce / throttle. N rapid
   * flushes → at most 2 actual patches.
   *
   * ## Pre-processing before diff
   *
   *   1. `SYSTEM_DATA_KEYS` (`id`, `type`, `createdAt`, `updatedAt`,
   *      `tmp`) are stripped from both sides. These are framework-
   *      managed: `updatedAt` is stamped by the adapter on every
   *      save / patch, `id` / `type` / `createdAt` never change, and
   *      `tmp` is client-only. The schema resolver deliberately
   *      excludes them from `__schema`, so emitting patch ops for
   *      them would throw `unknown column` at the backend adapter.
   *
   *   2. Both sides are JSON round-tripped to serialize Date objects
   *      (and other non-JSON natives) to stable string form. Without
   *      this, `fast-json-patch.compare` treats Date as a string
   *      iterable and produces 24 character-level `add` ops per Date
   *      field instead of equality.
   */
  async flush(): Promise<void> {
    if (this.__isNew) {
      return this.save();
    }

    // Trailing-coalesce: an existing in-flight flush captured an
    // earlier state; our caller's changes need a follow-up flush.
    // All trailing callers share the same promise so only one extra
    // round-trip runs regardless of how many deltas arrived.
    const inflight = this[SYM_FLUSH_INFLIGHT];
    if (inflight) {
      let trailing = this[SYM_FLUSH_TRAILING];
      if (!trailing) {
        trailing = (async () => {
          // Wait for the in-flight to finish. Swallow its error here —
          // it already rejected its own caller; a failed earlier
          // flush shouldn't block a later retry from running.
          try {
            await inflight;
          } catch {
            /* noop */
          }
          this[SYM_FLUSH_TRAILING] = null;
          // Recurse: the lane is now clear, this call will become
          // the next leading-edge flush.
          return this.flush();
        })();
        this[SYM_FLUSH_TRAILING] = trailing;
      }
      return trailing;
    }

    // Leading edge — no flush in-flight. Start one.
    const p = this._doFlush();
    this[SYM_FLUSH_INFLIGHT] = p;
    try {
      await p;
    } finally {
      this[SYM_FLUSH_INFLIGHT] = null;
    }
  }

  /** @internal — one-shot body of `flush()`. Computes the diff and
   * delegates to `patch()`. Callers must ensure serialization via
   * `flush()`'s `SYM_FLUSH_INFLIGHT` guard. */
  private async _doFlush(): Promise<void> {
    // Strip framework-managed columns AND coerce Date instances to
    // ISO strings in one pass — see the file-level `dateSafeClone`
    // for the why. Previously this was a separate `strip()` (one
    // walk) followed by `JSON.parse(JSON.stringify(...))` (one
    // walk + two string allocations) per side. The combined helper
    // collapses to one recursive walk per side and skips the
      // string allocations entirely.
    const stripAndDateClone = (
      data: Record<string, any>,
    ): Record<string, any> => {
      const out: Record<string, any> = {};
      for (const key of Object.keys(data)) {
        if (SYSTEM_DATA_KEYS.has(key)) continue;
        out[key] = dateSafeClone((data as any)[key]);
      }
      return out;
    };
    const snap = stripAndDateClone(this[SYM_SNAPSHOT] ?? {});
    const current = stripAndDateClone(this.__data);
    const ops = compare(snap, current) as unknown as PatchOp[];
    if (ops.length === 0) return;
    return this.patch(ops);
  }

  /**
   * Atomically overwrite this instance with server-authoritative data.
   *
   * Skips any keys with pending in-flight writes (their paths live in
   * `__patchingPaths`), deletes keys the server no longer has, refreshes
   * `__serverSnapshot` to mirror what the server actually holds, and
   * emits `"change"` exactly when something changed.
   */
  [SYM_SERVER_MERGE](serverData: Record<string, any>): this {
    const pending = this[SYM_PATCHING];
    const serverKeys = new Set(Object.keys(serverData));
    const schema = (this.constructor as typeof Model).__schema;
    let didChange = false;

    const keyHasPending = (key: string): boolean => {
      const prefix = `/${key}`;
      for (const p of pending) {
        if (p === prefix || p.startsWith(prefix + "/")) return true;
      }
      return false;
    };

    // Write new / changed values.
    for (const key of serverKeys) {
      if (keyHasPending(key)) continue;
      const nextVal = serverData[key];

      // Ref-field shortcut: incoming server data carries the raw id
      // (see `__data` getter — refs serialize via the `$field`
      // accessor). Compare against the raw-id slot, NOT against the
      // public getter (which returns the proxy / Model instance and
      // never equals the incoming string).
      //
      // Without this, every patch arriving over a subscription would
      // call the ref-field setter and `invalidate()` the cached
      // proxy — including the pre-hydrated proxy installed by
      // `.expand("file")`. The editor's `useAssetFile`
      // would then snap to `null` on every status flip / job update
      // until a fresh `findById` round-tripped the linked row again.
      //
      // When the raw id IS unchanged, skip the assignment so the
      // existing proxy survives. When it changed (reshoot, swap),
      // fall through to the setter so the stale proxy is correctly
      // invalidated.
      const col = schema?.[key];
      const isRef =
        col && typeof col === "object" && "kind" in col && col.kind === "ref";
      if (isRef) {
        if (Object.is((this as any)[`$${key}`], nextVal)) continue;
        (this as any)[key] = nextVal;
        didChange = true;
        continue;
      }

      if (!Object.is((this as any)[key], nextVal)) {
        (this as any)[key] = nextVal;
        didChange = true;
      }
    }

    // Delete keys the server no longer has. Same filter as __data so
    // we don't accidentally prune methods, EE internals, ref accessor
    // storage, or private state.
    //
    // Ref fields are also skipped — they're not regular data
    // properties, they're getter/setter pairs installed by
    // `_installRefField`. Deleting them tears out the accessor and
    // leaves `instance.fieldName` as `undefined` instead of the lazy
    // / pre-hydrated proxy. A payload that omits the ref key is
    // either a partial update (live diff) or a bug; either way we
    // leave the accessor alone. Real "ref cleared" goes through the
    // `serverData[key] = null` path in the loop above, which writes
    // through the setter correctly.
    for (const key of Object.keys(this)) {
      if (SYSTEM_DATA_KEYS.has(key)) continue;
      if (INSTANCE_METHODS.has(key)) continue;
      if (EVENTEMITTER_KEYS.has(key)) continue;
      if (key.startsWith("_") || key.startsWith("$")) continue;
      if (serverKeys.has(key)) continue;
      if (keyHasPending(key)) continue;
      const col = schema?.[key];
      if (
        col &&
        typeof col === "object" &&
        "kind" in col &&
        col.kind === "ref"
      ) {
        continue;
      }
      delete (this as any)[key];
      didChange = true;
    }

    // Snapshot always refreshes — it represents what the server holds,
    // independent of local pending writes.
    this[SYM_SNAPSHOT] = structuredClone(serverData);

    if (didChange) {
      (this as any)[SYM_VERSION] = (this as any)[SYM_VERSION] + 1;
      // Batched — fires once per microtask flush instead of N times
      // per server-frame burst. See `scheduleChangeEmit` above.
      scheduleChangeEmit(this);
    }

    return this;
  }

  async remove(): Promise<void> {
    await this[SYM_ADAPTER].remove(this);
    this.emit("removed", this);
  }

  /** Re-fetch from the adapter and merge via SYM_SERVER_MERGE. */
  async refresh(): Promise<void> {
    const fresh = await this[SYM_ADAPTER].findById(
      this.constructor as ModelConstructor,
      (this as any).id,
    );
    if (fresh) {
      this[SYM_SERVER_MERGE]((fresh as any).__data);
    }
  }

  /**
   * Project this instance into the shape that's safe to send to a
   * client. Subclasses can override for full control; the default
   * implementation projects every column EXCEPT those listed in
   * `static privateFields` on the subclass.
   *
   * The auto-CRUD routes (`GET /v1/<type>` / `GET /v1/<type>/:id`)
   * call this on every row. A subclass with a column like
   * `passwordHash` should add it to `privateFields`:
   *
   *   class User extends Model {
   *     static privateFields = ["passwordHash", "resetToken"]
   *     passwordHash: string = ""
   *     ...
   *   }
   *
   * `user` is supplied so subclasses can implement self-vs-other
   * projections (e.g. show your own private notes but not someone
   * else's). Default implementation ignores it — it's a uniform
   * shape for everyone.
   */
  sanitize(_user?: { id: string }): Record<string, any> {
    const ModelClass = this.constructor as typeof Model;
    const privateFields = ModelClass.privateFields;
    // `type` comes from the static — it's never been an instance
    // field. Output shape stays identical to pre-cleanup callers.
    const out: Record<string, any> = {
      type: ModelClass.type,
      ...this.__data,
    };
    if (privateFields && privateFields.length > 0) {
      for (const field of privateFields) {
        delete out[field];
      }
    }
    return out;
  }

  /**
   * Plain-object projection of this instance. UNLIKE `sanitize()` this
   * does NOT honour `privateFields` — `toJSON` is used internally by
   * the framework (subscription deltas, hook payloads, the
   * `__serverSnapshot` source-of-truth) where all columns are needed.
   * Don't expose `toJSON()` to clients directly; use `sanitize()` from
   * route handlers.
   */
  toJSON(): Record<string, any> {
    return {
      type: (this.constructor as typeof Model).type,
      ...this.__data,
    };
  }

  // ── Reference Proxy ──────────────────────────────────────────────────

  /**
   * Pre-hydrated ref proxy — same shape as `_createRefProxy` but
   * `loaded` starts populated, so property access is synchronous
   * and never fires `findById` / throws Suspense.
   *
   * Used by `_apply` when the wire payload included a `.expand(...)`
   * inline object for this ref field. The cache slot for
   * `${type}:${id}` is overwritten so a sibling read of the same
   * ref id elsewhere on the same instance (or across instances
   * within the 30s TTL) reuses this same hydrated proxy rather
   * than a stale lazy one.
   *
   * Field-projection note: `.expand("file.url")` builds an inline
   * row with only `{ id, type, url }`. Reading
   * `asset.file.blurhash` after a projected expand returns
   * `undefined` rather than triggering a lazy load — the caller
   * opted out of the other columns by projecting. If the caller
   * needs them, they ask for the whole row (`.expand("file")`).
   */
  private _createPrehydratedRefProxy(
    targetClass: ModelConstructor,
    refId: string,
    loadedInstance: Model,
  ): any {
    const proxy = this._buildRefProxy(targetClass, refId, loadedInstance);
    __refCache.set(`${targetClass.type}:${refId}`, {
      value: proxy,
      expires: Date.now() + REF_CACHE_TTL,
    });
    return proxy;
  }

  private _createRefProxy(targetClass: ModelConstructor, refId: string): any {
    const cacheKey = `${targetClass.type}:${refId}`;
    const cached = __refCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.value;
    if (cached) __refCache.delete(cacheKey);

    const proxy = this._buildRefProxy(targetClass, refId, null);
    return proxy;
  }

  /**
   * Shared proxy factory for `_createRefProxy` (lazy) and
   * `_createPrehydratedRefProxy` (eager). `initialLoaded === null`
   * routes the first non-whitelisted read through `findById`;
   * any other value short-circuits the lazy load entirely so the
   * read is synchronous.
   *
   * The trap shape stays identical between the two cases — iteration
   * safety still applies. Pre-hydration is fundamentally
   * a "preload the cache slot" optimization, not a different proxy
   * protocol.
   */
  private _buildRefProxy(
    targetClass: ModelConstructor,
    refId: string,
    initialLoaded: Model | null,
  ): any {
    let loaded: any = initialLoaded;
    let loading: Promise<any> | null = null;
    const cacheKey = `${targetClass.type}:${refId}`;

    const proxy = new Proxy({} as any, {
      get(_target, prop) {
        if (prop === "id") return refId;
        if (prop === "type") return targetClass.type;
        if (prop === "then") return undefined;
        if (prop === "toJSON")
          return () => ({ id: refId, type: targetClass.type });
        if (prop === Symbol.toPrimitive) return () => refId;

        if (loaded) return (loaded as any)[prop];

        if (!loading) {
          loading = Model.getAdapter()
            .findById(targetClass, refId)
            .then((result) => {
              loaded = result;
              __refCache.set(cacheKey, {
                value: proxy,
                expires: Date.now() + REF_CACHE_TTL,
              });
              return result;
            });
        }

        // React Suspense integration — throw the pending promise.
        throw loading;
      },
      // ── Iteration safety ─────────────────────────────────────────
      //
      // Without these two traps, `Object.keys(proxy)` /
      // `JSON.stringify(walk)` / `for..in` would surface the empty
      // backing target (`{}`) and any framework-internal property
      // lookup (DevTools console expansion, `lodash.isEqual`,
      // `react-fast-compare`) would land on the `get` trap above
      // and fire `findById` plus throw a Promise into a consumer
      // that almost never wants either. We restrict the visible
      // surface to the same whitelist the `get` trap returns
      // synchronously — `{id, type}` — so iteration sees a tidy
      // 2-key stub and stays clear of the lazy-load path.
      ownKeys(): ArrayLike<string | symbol> {
        return ["id", "type"];
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (prop === "id") {
          return {
            value: refId,
            writable: false,
            enumerable: true,
            configurable: true,
          };
        }
        if (prop === "type") {
          return {
            value: targetClass.type,
            writable: false,
            enumerable: true,
            configurable: true,
          };
        }
        return undefined;
      },
      has(_target, prop) {
        return prop === "id" || prop === "type";
      },
    });

    return proxy;
  }
}

/**
 * Adds typed `$`-prefixed string accessors for all reference fields.
 * The accessor installation in `_apply()` provides these at runtime —
 * this type just surfaces them to TypeScript so no casting is needed.
 *
 * The mapped-type predicate uses `NonNullable<T[K]> extends Model`
 * (rather than `T[K] extends Model`) so nullable ref columns like
 * `file: File | null = null` still surface their `$file` accessor.
 * Without the unwrap, `File | null extends Model` resolves to
 * `never` and the `$<ref>` accessor disappears from the projected
 * type — even though the runtime installer fires regardless of
 * nullability.
 */
export type WithRefs<T extends Model> = T & {
  [K in keyof T as NonNullable<T[K]> extends Model
    ? `$${string & K}`
    : never]: string;
};
