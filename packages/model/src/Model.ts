/**
 * @parcae/model — Model Base Class
 *
 * The instance IS the data store. No Proxy wrapper, no write interception.
 * Writes are explicit primitives:
 *
 *   - save()        → upsert the entire current document. No diff, no
 *                     dirty-tracking. Used for creates and full-document
 *                     writes. Runs the adapter's "save" path (which on
 *                     the backend invokes "save" hooks).
 *
 *   - stage(ops)    → apply RFC 6902 ops locally and emit them without
 *                     persistence or write-state changes.
 *
 *   - patch(ops)    → stage RFC 6902 ops locally, then send them. Caller
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
 * `"operations"` synchronously reports staged, patched, and effective remote
 * RFC 6902 changes with the current model revision. Direct field writes do
 * NOT emit; use stage() / patch(), or flush() to persist them.
 *
 * Row data is immutable: write it with stage() / patch() or a top-level
 * assignment, never in place. Every write and merge copies only the path it
 * changes and keeps each equal value, so `===` says whether a value changed,
 * and the snapshot shares every value the server and the row agree on.
 *
 * `stage()` / `patch()` / `flush()` emit synchronously (optimistic UI relies on
 * the immediate update). `SYM_SERVER_MERGE` emits via a microtask-
 * batched queue — multiple per-row merges in a single server frame
 * coalesce into one render commit per instance. See
 * `scheduleChangeEmit` for the batching contract.
 */

import { EventEmitter } from "eventemitter3";
import ShortId from "short-unique-id";
import {
  diff,
  same,
  share,
  patched,
  dedupOps,
  pointerSegments,
  encodePointerSegment,
} from "./patch";
import {
  CHAINABLE_METHODS,
  type ModelAdapter,
  type ModelConstructor,
  type QueryChain,
  type SchemaDefinition,
  type PatchOp,
  type ScopeContext,
} from "./adapters/types";

export type ModelOperationSource = "local" | "remote";

export interface ModelOperationsEvent {
  readonly ops: readonly PatchOp[];
  readonly source: ModelOperationSource;
  readonly revision: number;
}

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
/** Tail of the instance's single save/patch/flush write lane. */
const SYM_WRITE_LANE = Symbol("parcae:writeLane");
/** Schema-known or wire-declared reference field names. */
const SYM_REF_FIELDS = Symbol("parcae:refFields");
/** Symbol marker carried by plain expanded projections. */
export const SYM_EXPANDED_REF = Symbol.for("parcae:expandedRef");

const classAdapters = new WeakMap<ModelConstructor, ModelAdapter>();
const boundSources = new WeakMap<ModelConstructor, ModelConstructor>();
const adapterBindings = new WeakMap<
  ModelAdapter,
  WeakMap<ModelConstructor, ModelConstructor>
>();
const adapterWaiters = new Map<
  ModelConstructor,
  {
    promise: Promise<ModelAdapter>;
    resolve: (adapter: ModelAdapter) => void;
  }
>();

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

/** Apply server-authored RFC 6902 ops, including paths below expanded refs. */
export const SYM_SERVER_PATCH = Symbol("parcae:serverPatch");

/**
 * Monotonic version counter bumped on every `"change"` emit. Exported so
 * the SDK's `revision(row)` signal can read it.
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
  let firstError: unknown;
  for (const model of drain) {
    try {
      model.emit("change");
    } catch (err) {
      firstError ??= err;
    }
  }
  if (firstError !== undefined) throw firstError;
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
  "stage",
  "patch",
  "flush",
  "remove",
  "refresh",
  "sanitize",
  "toJSON",
  "get",
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
function applyInstance(instance: Model): void {
  instance._apply();
}

/** Stamp the `__isNew` flag. Same centralisation rationale. */
function markNew(instance: any, value: boolean): void {
  instance.__isNew = value;
}

function getBoundAdapter(
  modelClass: ModelConstructor,
): ModelAdapter | null {
  let current: object | null = modelClass;
  while (current && current !== Function.prototype) {
    const adapter = classAdapters.get(current as ModelConstructor);
    if (adapter) return adapter;
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function resolveAdapterWaiters(): void {
  for (const [modelClass, waiter] of adapterWaiters) {
    const adapter = getBoundAdapter(modelClass);
    if (!adapter) continue;
    adapterWaiters.delete(modelClass);
    waiter.resolve(adapter);
  }
}

function waitForClassAdapter(modelClass: ModelConstructor): Promise<ModelAdapter> {
  const adapter = getBoundAdapter(modelClass);
  if (adapter) return Promise.resolve(adapter);
  let waiter = adapterWaiters.get(modelClass);
  if (!waiter) {
    let resolve!: (adapter: ModelAdapter) => void;
    const promise = new Promise<ModelAdapter>((done) => {
      resolve = done;
    });
    waiter = { promise, resolve };
    adapterWaiters.set(modelClass, waiter);
  }
  return waiter.promise;
}

function bindModelClass<T extends ModelConstructor>(
  modelClass: T,
  adapter: ModelAdapter,
): T {
  if (getBoundAdapter(modelClass) === adapter && classAdapters.has(modelClass)) {
    return modelClass;
  }
  const source = boundSources.get(modelClass) ?? modelClass;
  let bindings = adapterBindings.get(adapter);
  if (!bindings) {
    bindings = new WeakMap();
    adapterBindings.set(adapter, bindings);
  }
  const existing = bindings.get(source);
  if (existing) return existing as T;
  const BoundModel = class extends (source as typeof Model) {};
  classAdapters.set(BoundModel, adapter);
  boundSources.set(BoundModel, source);
  bindings.set(source, BoundModel);
  resolveAdapterWaiters();
  return BoundModel as unknown as T;
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

function lazyQuery<T extends Model>(
  modelClass: ModelConstructor<T>,
  steps: any[] = [],
  keySteps: any[] = [],
  capturedAdapter: ModelAdapter | null = getBoundAdapter(modelClass),
): QueryChain<WithRefs<T>> {
  const chain: any = {};

  for (const method of CHAINABLE_METHODS) {
    chain[method] = (...args: any[]) =>
      lazyQuery(
        modelClass,
        [...steps, { method, args }],
        [...keySteps, { method, args: serializeLazyQueryArgs(args) }],
        capturedAdapter,
      );
  }

  const resolve = async (): Promise<QueryChain<WithRefs<T>>> => {
    const adapter =
      capturedAdapter ??
      getBoundAdapter(modelClass) ??
      (await waitForClassAdapter(modelClass));
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
  chain.update = async (patch: Record<string, any>) =>
    (await resolve()).update(patch as Partial<WithRefs<T>> & Record<string, any>);

  chain.__steps = keySteps;
  chain.__modelType = modelClass.type;
  chain.__modelClass = modelClass;
  chain.__adapter = capturedAdapter;

  return chain as QueryChain<WithRefs<T>>;
}

// ─── Patch helpers ──────────────────────────────────────────────────────────

function prefixPatchOps(field: string, ops: readonly PatchOp[]): PatchOp[] {
  const prefix = `/${encodePointerSegment(field)}`;
  // boundary: spreading the fast-json-patch discriminated union preserves it.
  return ops.map((op) => ({
    ...op,
    path: `${prefix}${op.path}`,
    ...((op.op === "copy" || op.op === "move")
      ? { from: `${prefix}${op.from}` }
      : {}),
  })) as PatchOp[];
}

/**
 * A JSON-safe deep copy of `value`: `Date` instances become ISO strings and
 * arrays/objects are cloned, matching `JSON.parse(JSON.stringify(value))`'s
 * own-enumerable traversal.
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

/**
 * The version of one row as a client holds it: its `updatedAt` and each
 * expanded ref's, in `refs` order. A resync compares it to skip rows
 * the client already has. A write in the same millisecond as the last
 * one keeps the version, so it reaches a client only as a patch.
 */
export function rowVersion(row: Record<string, any>, refs: readonly string[]): string {
  const stamp = (value: unknown) => {
    if (value === null || value === undefined) return "";
    const time = new Date(value as string).getTime();
    return Number.isFinite(time) ? String(time) : String(value);
  };
  return [row.updatedAt, ...refs.map((ref) => row[ref]?.updatedAt)].map(stamp).join(":");
}

function rawReferenceId(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (value && typeof value === "object" && typeof (value as any).id === "string") {
    return (value as any).id || null;
  }
  return null;
}

/** The server's row with the local edits made since `baselineData` replayed on top. */
function mergeServerWithLocalChanges(
  serverData: Record<string, any>,
  baselineData: Record<string, any>,
  currentData: Record<string, any>,
): Record<string, any> {
  const localOps = diff(baselineData, currentData);
  return localOps.length === 0 ? serverData : patched(serverData, localOps);
}

/** Return the top-level fields written by a batch of ops. */
function topLevelKeys(ops: readonly PatchOp[]): Set<string> {
  const keys = new Set<string>();
  for (const op of ops) {
    if (op.op === "test") continue;
    const top = pointerSegments(op.path)[0];
    if (top !== undefined) keys.add(top);
    if (op.op === "move") {
      const fromTop = pointerSegments(op.from)[0];
      if (fromTop !== undefined) keys.add(fromTop);
    }
  }
  return keys;
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
  declare [SYM_PATCHING]: Map<string, number>;
  declare [SYM_SNAPSHOT]: Record<string, any>;
  declare [SYM_PENDING_DATA]: Record<string, any> | undefined;
  declare [SYM_WRITE_LANE]: Promise<void> | null | undefined;
  declare [SYM_REF_FIELDS]: Set<string>;
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
    /** Per-field query policy — see `ModelScope["fields"]`. */
    fields?: Record<string, (ctx: any) => any>;
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
   * Additional fields protected only after a row has been created.
   * Auto-CRUD `POST` accepts these columns, while `PUT` strips them and
   * `PATCH` rejects operations that target them. A resolver can vary the
   * protected fields by request context. This lets applications define
   * create-time identifiers or relationships without imposing any
   * domain-specific field names at framework level.
   *
   * Server-side model writes are unaffected. Default is empty so existing
   * models remain backward-compatible.
   */
  static readonly updateReadonlyFields:
    | readonly string[]
    | ((ctx: ScopeContext) => readonly string[]) = [];
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

  /**
   * Bind the default adapter for this constructor exactly once.
   * Independent applications should use bind() instead of replacing it.
   */
  static use(adapter: ModelAdapter): void {
    const modelClass = this as unknown as ModelConstructor;
    const ownAdapter = classAdapters.get(modelClass);
    if (ownAdapter && ownAdapter !== adapter) {
      throw new Error(
        "Adapter already set for this model context. Use Model.bind(adapter) for an independent context.",
      );
    }
    if (!ownAdapter) classAdapters.set(modelClass, adapter);
    resolveAdapterWaiters();
  }

  /**
   * Return an adapter-bound constructor without mutating the source class.
   * Static metadata is inherited and instances remain instanceof the source.
   */
  static bind<T extends typeof Model>(this: T, adapter: ModelAdapter): T {
    return bindModelClass(this as unknown as ModelConstructor, adapter) as T;
  }

  static getAdapter(): ModelAdapter {
    const adapter = getBoundAdapter(
      this as unknown as ModelConstructor,
    );
    if (!adapter) {
      throw new Error(
        "No adapter bound. Call Model.use(adapter) once or use ModelClass.bind(adapter).",
      );
    }
    return adapter;
  }

  static hasAdapter(): boolean {
    return getBoundAdapter(this as unknown as ModelConstructor) !== null;
  }

  static waitForAdapter(): Promise<ModelAdapter> {
    return waitForClassAdapter(this as unknown as ModelConstructor);
  }

  // ── Static Query Methods ───────────────────────────────────────────
  //
  // Every method below uses `this: ModelConstructor<T>` so the typing
  // closes via the call shape: `Scene.where(...)` binds T = Scene from
  // `typeof Scene satisfies ModelConstructor<Scene>`. Hydration and query
  // boundaries retain `WithRefs<T>`, surfacing the `$` raw-id accessors
  // that `_apply()` installs at runtime.

  /**
   * Create a new, unsaved Model instance. Data provided here wins over
   * any field-initializer defaults on the subclass (because _apply() runs
   * AFTER the subclass's field initializers have fired).
   */
  static create<T extends Model>(
    this: ModelConstructor<T>,
    data?: Record<string, any>,
  ): WithRefs<T> {
    const instance = new this(
      Model.getAdapter.call(this as unknown as typeof Model),
      data,
    );
    applyInstance(instance);
    markNew(instance, true);
    return instance as WithRefs<T>;
  }

  /**
   * Hydrate an instance from server/DB data. Used by adapters — the
   * result is NOT marked `__isNew`, and `__serverSnapshot` is seeded
   * from `data` so flush() knows there's nothing to send initially.
   *
   * Adapters are generic, but hydration still installs the `$` raw-id
   * accessors, so retain them in the result type.
   */
  static hydrate<T extends Model>(
    this: ModelConstructor<T>,
    adapter: ModelAdapter,
    data: Record<string, any>,
  ): WithRefs<T> {
    const instance = new this(adapter, data);
    applyInstance(instance);
    markNew(instance, false);
    return instance as WithRefs<T>;
  }

  static findById<T extends Model>(
    this: ModelConstructor<T>,
    id: string,
  ): Promise<WithRefs<T> | null> {
    return Model.getAdapter
      .call(this as unknown as typeof Model)
      .findById(this, id);
  }

  static where<T extends Model>(
    this: ModelConstructor<T>,
    ...args: any[]
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).where(...args);
  }

  static whereRaw<T extends Model>(
    this: ModelConstructor<T>,
    query: string,
    ...bindings: any[]
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).whereRaw(query, ...bindings);
  }

  static whereIn<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
    values: any[],
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).whereIn(column, values);
  }

  static whereNot<T extends Model>(
    this: ModelConstructor<T>,
    ...args: any[]
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).whereNot(...args);
  }

  static whereNotIn<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
    values: any[],
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).whereNotIn(column, values);
  }

  static whereNull<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).whereNull(column);
  }

  static whereNotNull<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).whereNotNull(column);
  }

  static select<T extends Model>(
    this: ModelConstructor<T>,
    ...columns: string[]
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).select(...columns);
  }

  static count<T extends Model>(this: ModelConstructor<T>): Promise<number> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).count();
  }

  static sum<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
  ): Promise<number> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).sum(column);
  }

  static search<T extends Model>(
    this: ModelConstructor<T>,
    term: string,
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).search(term);
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
    this[SYM_PATCHING] = new Map<string, number>();
    this[SYM_SNAPSHOT] = {};
    this[SYM_REF_FIELDS] = new Set();
    (this as any)[SYM_VERSION] = 0;
    if (data) this[SYM_PENDING_DATA] = data;
  }

  /**
   * Apply staged constructor data on top of subclass field-initializer
   * defaults, install ref-field accessors from the schema, and seed
   * `__serverSnapshot`. Called exactly once by the static factories.
   */
  /** @internal */
  _apply(): void {
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
    // Subclass field initializers like `author: Ref<Author> | null = null`
    // may have already written a data property — `defineProperty`
    // overrides cleanly, so we still avoid the deopt-inducing
    // `delete + defineProperty` pattern of the previous design.
    const schema = (this.constructor as typeof Model).__schema;
    const refFields = new Set<string>();
    if (schema) {
      for (const [field, col] of Object.entries(schema)) {
        if (typeof col === "object" && col !== null && "kind" in col && col.kind === "ref") {
          refFields.add(field);
        }
      }
    } else {
      // Expanded wire rows carry both `field: { id, ... }` and `$field: id`.
      // That explicit pair is enough to recover ref semantics without shipping
      // the backend's schema resolver to the client.
      for (const key of Object.keys(data)) {
        if (!key.startsWith("$") || key.length === 1) continue;
        const field = key.slice(1);
        if (Object.prototype.hasOwnProperty.call(data, field)) refFields.add(field);
      }
    }
    this[SYM_REF_FIELDS] = refFields;
    for (const field of refFields) {
      this._installRefField(
        field,
        data[field] ?? data[`$${field}`] ?? (this as any)[field] ?? null,
      );
    }

    // Apply provided non-system, non-ref data. These OVERWRITE subclass
    // field defaults because we're running after the subclass's field
    // initializers finished. `type` is in SYSTEM_DATA_KEYS so old
    // payloads (e.g. a JSON snapshot from before the field was
    // dropped) don't accidentally write a stale type onto the
    // instance. Ref fields are skipped — their values were already
    // consumed into the accessor closures above. `$`-prefixed keys are
    // skipped too: that namespace belongs to the raw-id accessors
    // installed above, so a stray `$field` key in the payload (e.g. a
    // leaked DB column or an over-eager serializer) would otherwise
    // write through the accessor's setter and clobber the ref id the
    // ref loop just installed.
    for (const [key, value] of Object.entries(data)) {
      if (SYSTEM_DATA_KEYS.has(key)) continue;
      if (refFields.has(key)) continue;
      // Skip `$`-prefixed keys — these are runtime raw-id accessors
      // installed by _installRefField. A stale `$user` column lingering
      // in the DB (pre-migration) would clobber the ref state's raw slot
      // through the accessor's setter, wiping the real value.
      if (key.startsWith("$")) continue;
      (this as any)[key] = value;
    }

    // Install synchronized `$key = key?.id ?? key ?? null` accessors for
    // schema-free clients and field-initializer defaults. Typed callers only
    // see accessors for `Ref<Model>` fields through `WithRefs<T>`; the broader
    // runtime fallback keeps hydration correct when client schema is absent.
    for (const key of Object.keys(this)) {
      if (SYSTEM_DATA_KEYS.has(key) || key.startsWith("_") || key.startsWith("$")) continue;
      if (EVENTEMITTER_KEYS.has(key) || INSTANCE_METHODS.has(key)) continue;
      this._installRawAccessor(key);
    }

    // Seed the server snapshot from the fully-applied state. For a
    // fresh create() the server doesn't actually know about this
    // record yet (snapshot represents "nothing persisted"), but
    // __isNew routes flush() → save() in that case, so the snapshot
    // contents don't matter until after the first save ack refreshes
    // it. For hydrate() the snapshot correctly mirrors the server.
    this[SYM_SNAPSHOT] = this.__data;
  }

  /** Keep an expanded object or raw id on the field and expose its raw id at `$field`. */
  private _installRefField(field: string, incoming: unknown): void {
    this[SYM_REF_FIELDS].add(field);
    const v =
      incoming instanceof Model
        ? incoming
        : incoming && typeof incoming === "object" && typeof (incoming as any).id === "string"
        ? this._markExpandedRef(incoming as Record<string, any>)
        : typeof incoming === "string"
        ? incoming || null
        : null;
    (this as any)[field] = v;
    this._installRawAccessor(field);
  }

  private _markExpandedRef(value: Record<string, any>): Record<string, any> {
    if ((value as any)[SYM_EXPANDED_REF] === true) return value;
    try {
      Object.defineProperty(value, SYM_EXPANDED_REF, {
        configurable: true,
        enumerable: true,
        value: true,
      });
      return value;
    } catch {
      const copy = { ...value };
      Object.defineProperty(copy, SYM_EXPANDED_REF, {
        enumerable: true,
        value: true,
      });
      return copy;
    }
  }

  /**
   * Install the synchronized raw-value companion used by ref fields, once
   * per class on its prototype: the accessor reads `this`, so every object
   * built on the prototype projects its raw ids, a clone included.
   */
  private _installRawAccessor(field: string): void {
    const prototype = Object.getPrototypeOf(this);
    if (Object.prototype.hasOwnProperty.call(prototype, `$${field}`)) return;
    Object.defineProperty(prototype, `$${field}`, {
      configurable: true,
      enumerable: false,
      get(this: any) {
        const current = this[field];
        return current?.id ?? current ?? null;
      },
      set(this: any, value: unknown) {
        this[field] = value ?? null;
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
    const data: Record<string, any> = {};
    for (const key of Object.keys(this)) {
      if (EVENTEMITTER_KEYS.has(key)) continue;
      if (INSTANCE_METHODS.has(key)) continue;
      if (key.startsWith("_")) continue;
      if (key.startsWith("$")) continue;
      const value = (this as any)[key];
      if (
        !this[SYM_REF_FIELDS].has(key) &&
        (value instanceof Model || value?.[SYM_EXPANDED_REF] === true)
      ) {
        this[SYM_REF_FIELDS].add(key);
        this._installRawAccessor(key);
      }
      if (this[SYM_REF_FIELDS].has(key)) {
        // Read the raw id directly; the field may hold an expanded object.
        data[key] = (this as any)[`$${key}`];
      } else {
        data[key] = value;
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
    return new Set(this[SYM_PATCHING].keys());
  }

  /** @internal — last server-authoritative view; what flush() diffs against */
  get __serverSnapshot(): Readonly<Record<string, any>> {
    return this[SYM_SNAPSHOT];
  }

  /** @internal — adapter-only. `hydrate()` seeds the snapshot from the
   * data it's given, which for a save's captured operation model is the
   * POST-edit state; the backend adapter uses this to re-seed the
   * captured model with the caller's true pre-save snapshot so save
   * hooks can diff before → after. */
  set __serverSnapshot(data: Readonly<Record<string, any>>) {
    this[SYM_SNAPSHOT] = { ...data };
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

  // ── Persistence ──────────────────────────────────────────────────────

  /**
   * Upsert the entire current document to the server. No diffing, no
   * dirty-tracking — the adapter receives an immutable snapshot of the
   * document captured when save() was called.
   *
   * Runs the adapter's "save" pipeline (on the backend: "create" /
   * "save" hooks, full INSERT ... ON CONFLICT MERGE).
   */
  save(): Promise<void> {
    (this as any).updatedAt = new Date().toISOString();
    const data = this.__data;
    return this._enqueueWrite(() => this._writeSave(data));
  }

  /**
   * Apply a batch of RFC 6902 ops locally without persisting it or entering
   * patching/saving state. Emits `"operations"`, then `"change"`,
   * synchronously for optimistic consumers.
   */
  stage(rawOps: PatchOp[]): void {
    this._applyLocalOperations(rawOps);
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
  patch(rawOps: PatchOp[]): Promise<void> {
    const ops = this._applyLocalOperations(rawOps);
    if (ops.length === 0) return Promise.resolve();

    const expectedData = this.__data;
    const paths = this._beginPatch(ops);
    return this._enqueueWrite(() =>
      this._writePatch(ops, expectedData, paths),
    );
  }

  private _applyLocalOperations(rawOps: PatchOp[]): PatchOp[] {
    if (rawOps.length === 0) return [];
    // Normalize: drop ops whose path lives UNDER another `remove`
    // op in the same batch. Without this, fast-json-patch crashes
    // on the sub-path op when its parent has just been removed.
    // Callers can freely compose helpers — the framework keeps the
    // batch consistent. See `patch.ts:dedupOps` for the contract. The
    // row owns its copy of the values the ops carry.
    const ops = structuredClone(dedupOps(rawOps)) as PatchOp[];
    if (ops.length === 0) return ops;

    this._copyPatchedTopLevels(patched(this.__data, ops), ops);

    (this as any)[SYM_VERSION] = (this as any)[SYM_VERSION] + 1;
    this._emitOperations(ops, "local");
    this.emit("change");
    return ops;
  }

  private _emitOperations(
    ops: readonly PatchOp[],
    source: ModelOperationSource,
  ): void {
    this.emit("operations", {
      ops: structuredClone(ops),
      source,
      revision: this[SYM_VERSION],
    } satisfies ModelOperationsEvent);
  }

  private _enqueueWrite(write: () => Promise<void>): Promise<void> {
    const previous = this[SYM_WRITE_LANE];
    const current = previous
      ? previous.then(write, write)
      : write();
    this[SYM_WRITE_LANE] = current;
    const clear = (): void => {
      if (this[SYM_WRITE_LANE] === current) this[SYM_WRITE_LANE] = null;
    };
    void current.then(clear, clear);
    return current;
  }

  private async _writeSave(data: Record<string, any>): Promise<void> {
    this.__savingCount++;
    this.emit("saving", this);
    this.emit("__saving", this.__savingCount);
    try {
      const serverData = await this[SYM_ADAPTER].save(this, data);
      if (serverData) {
        this[SYM_SERVER_MERGE](serverData, data);
      } else {
        this._replaceServerSnapshot(data);
      }
      this.__isNew = false;
      this.emit("saved", this);
    } finally {
      this.__savingCount = Math.max(0, this.__savingCount - 1);
      this.emit("__saving", this.__savingCount);
    }
  }

  private _beginPatch(ops: readonly PatchOp[]): Set<string> {
    const paths = new Set(ops.map((op) => op.path));
    for (const path of paths) {
      this[SYM_PATCHING].set(path, (this[SYM_PATCHING].get(path) ?? 0) + 1);
    }
    this.__savingCount++;
    this.emit("patching", this);
    this.emit("__saving", this.__savingCount);
    return paths;
  }

  private _endPatch(paths: ReadonlySet<string>): void {
    for (const path of paths) {
      const count = this[SYM_PATCHING].get(path) ?? 0;
      if (count <= 1) this[SYM_PATCHING].delete(path);
      else this[SYM_PATCHING].set(path, count - 1);
    }
    this.__savingCount = Math.max(0, this.__savingCount - 1);
    this.emit("__saving", this.__savingCount);
  }

  private async _writePatch(
    ops: PatchOp[],
    expectedData: Record<string, any>,
    paths: ReadonlySet<string>,
  ): Promise<void> {
    try {
      const serverData = await this[SYM_ADAPTER].patch(
        this,
        ops,
        expectedData,
      );
      if (serverData) {
        this[SYM_SERVER_MERGE](serverData, expectedData);
      } else {
        this._replaceServerSnapshot(expectedData);
      }
      this.emit("patched", this);
    } finally {
      this._endPatch(paths);
    }
  }

  private _copyPatchedTopLevels(
    snapshot: Record<string, any>,
    ops: readonly PatchOp[],
  ): void {
    for (const key of topLevelKeys(ops)) {
      if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
        (this as any)[key] = snapshot[key];
      } else {
        delete (this as any)[key];
      }
    }
  }

  private _replaceServerSnapshot(data: Record<string, any>): void {
    this[SYM_SNAPSHOT] = { ...data };
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
   * All flushes share the same write lane as save() and patch(). A queued
   * flush computes its diff only after prior writes acknowledge, so it
   * captures edits made while those writes were awaiting the adapter.
   *
   * `SYSTEM_DATA_KEYS` (`id`, `type`, `createdAt`, `updatedAt`, `tmp`)
   * are framework-managed and never in the diff: the schema resolver
   * excludes them from `__schema`, so the backend adapter would reject
   * their ops as unknown columns. The snapshot shares every value the
   * row did not change, so the diff walks only what did.
   */
  flush(): Promise<void> {
    return this._enqueueWrite(() => this._doFlush());
  }

  /** @internal — one-shot body of `flush()`. Computes the diff and
   * delegates directly to the active write lane. */
  private async _doFlush(): Promise<void> {
    if (this.__isNew) {
      (this as any).updatedAt = new Date().toISOString();
      return this._writeSave(this.__data);
    }

    const owned = (data: Record<string, any>) =>
      Object.fromEntries(Object.entries(data).filter(([key]) => !SYSTEM_DATA_KEYS.has(key)));
    const ops = diff(owned(this[SYM_SNAPSHOT] ?? {}), owned(this.__data));
    if (ops.length === 0) return;
    const expectedData = this.__data;
    const paths = this._beginPatch(ops);
    (this as any)[SYM_VERSION] = (this as any)[SYM_VERSION] + 1;
    this.emit("change");
    return this._writePatch(ops, expectedData, paths);
  }

  /**
   * Atomically merge a server row while replaying local edits made after the
   * supplied baseline. Write acknowledgements use their outbound payload as
   * that baseline; fetches and subscriptions use the prior server snapshot.
   */
  [SYM_SERVER_MERGE](
    serverValue: Record<string, any> | Model,
    expectedData?: Record<string, any>,
    removedFields?: ReadonlySet<string>,
  ): this {
    const before = this.listenerCount("operations") > 0 ? this.__data : null;
    const sourceModel = serverValue instanceof Model ? serverValue : null;
    const incomingData: Record<string, any> = sourceModel
      ? sourceModel.__data
      : (serverValue as Record<string, any>);
    const refFields = new Set(this[SYM_REF_FIELDS]);
    if (sourceModel) {
      for (const field of sourceModel[SYM_REF_FIELDS]) refFields.add(field);
    }
    for (const key of Object.keys(incomingData)) {
      if (!key.startsWith("$") || key.length === 1) continue;
      const field = key.slice(1);
      if (Object.prototype.hasOwnProperty.call(incomingData, field)) refFields.add(field);
    }
    this[SYM_REF_FIELDS] = refFields;
    const authoritativeData: Record<string, any> = { ...expectedData };

    for (const [key, value] of Object.entries(incomingData)) {
      if (key.startsWith("$")) continue;
      if (refFields.has(key)) {
        const rawKey = `$${key}`;
        const refValue = Object.prototype.hasOwnProperty.call(incomingData, rawKey)
          ? incomingData[rawKey]
          : value;
        authoritativeData[key] =
          refValue instanceof Model
            ? refValue.id
            : refValue && typeof refValue === "object"
              ? (refValue as Record<string, any>).id ?? null
              : refValue;
      } else {
        authoritativeData[key] = value;
      }
    }

    const currentData = this.__data;
    const mergedData = mergeServerWithLocalChanges(
      authoritativeData,
      expectedData ?? this[SYM_SNAPSHOT],
      currentData,
    );
    const mergedKeys = new Set(Object.keys(mergedData));
    const serverKeys = new Set(Object.keys(authoritativeData));
    let didChange = false;

    for (const [key, nextVal] of Object.entries(mergedData)) {
      if (key === "type") continue;
      const isRef = refFields.has(key);
      if (isRef) {
        let incoming: unknown = nextVal ?? null;
        let isUnavailableExpansion = false;
        if (same(nextVal, authoritativeData[key])) {
          const source = sourceModel ? (sourceModel as any)[key] : incomingData[key];
          if (source instanceof Model || (source && typeof source === "object")) {
            incoming = source;
          } else if (
            !sourceModel &&
            Object.prototype.hasOwnProperty.call(incomingData, `$${key}`) &&
            source == null &&
            authoritativeData[key] != null
          ) {
            incoming = authoritativeData[key];
            isUnavailableExpansion = true;
          }
        }
        const current = (this as any)[key];
        const currentId = rawReferenceId(current);
        const incomingId = rawReferenceId(incoming);
        let didExpandedChange = false;
        if (
          currentId &&
          currentId === incomingId &&
          current &&
          typeof current === "object" &&
          !isUnavailableExpansion
        ) {
          if (incoming && typeof incoming === "object" && incoming !== current) {
            didExpandedChange = !same(current, incoming);
            if (!didExpandedChange) {
              incoming = current;
            } else if (current instanceof Model && incoming instanceof Model) {
              current[SYM_SERVER_MERGE](incoming);
              incoming = current;
            } else if (!(current instanceof Model) && !(incoming instanceof Model)) {
              incoming = share(current, incoming);
            }
          } else {
            incoming = current;
          }
        }
        const prev = (this as any)[`$${key}`];
        this._installRefField(key, incoming);
        if (
          (this as any)[`$${key}`] !== prev ||
          didExpandedChange ||
          !Object.is(current, incoming)
        ) {
          didChange = true;
        }
        continue;
      }

      const value = share((this as any)[key], nextVal);
      if (!Object.is((this as any)[key], value)) {
        (this as any)[key] = value;
        didChange = true;
      }
      if (!SYSTEM_DATA_KEYS.has(key)) this._installRawAccessor(key);
    }

    for (const key of Object.keys(this)) {
      if (SYSTEM_DATA_KEYS.has(key)) continue;
      if (INSTANCE_METHODS.has(key)) continue;
      if (EVENTEMITTER_KEYS.has(key)) continue;
      if (key.startsWith("_") || key.startsWith("$")) continue;
      if (mergedKeys.has(key)) continue;
      if (refFields.has(key)) {
        if (!removedFields?.has(key)) continue;
        if ((this as any)[key] != null) {
          this._installRefField(key, null);
          didChange = true;
        }
        continue;
      }
      delete (this as any)[key];
      didChange = true;
    }

    // The snapshot is the server's row, sharing each value the row agrees with.
    const snapshot: Record<string, any> = {};
    for (const [key, value] of Object.entries(this[SYM_SNAPSHOT])) {
      if (serverKeys.has(key)) continue;
      if (removedFields?.has(key)) snapshot[key] = null;
      else if (refFields.has(key)) snapshot[key] = value;
    }
    for (const [key, value] of Object.entries(authoritativeData))
      snapshot[key] = refFields.has(key) ? value : share((this as any)[key], value);
    for (const field of removedFields ?? []) snapshot[field] = null;
    this[SYM_SNAPSHOT] = snapshot;

    if (didChange) {
      (this as any)[SYM_VERSION] = (this as any)[SYM_VERSION] + 1;
      if (before) {
        const ops = diff(before, this.__data);
        if (ops.length > 0) this._emitOperations(ops, "remote");
      }
      scheduleChangeEmit(this);
    }

    return this;
  }

  [SYM_SERVER_PATCH](ops: readonly PatchOp[]): this {
    const outerOps: PatchOp[] = [];
    const refOps = new Map<string, PatchOp[]>();

    for (const op of ops) {
      const segments = pointerSegments(op.path);
      const fieldVal = segments.length > 1 ? (this as any)[segments[0]!] : null;
      const isNestedRef =
        segments.length > 1 &&
        this[SYM_REF_FIELDS].has(segments[0]!) &&
        !!(fieldVal && typeof fieldVal === "object");
      const from = op.op === "copy" || op.op === "move" ? op.from : null;
      const fromSegments = from ? pointerSegments(from) : null;
      if (!isNestedRef || (fromSegments && fromSegments[0] !== segments[0])) {
        outerOps.push(op);
        continue;
      }
      const pathStart = op.path.indexOf("/", 1);
      const relative = {
        ...op,
        path: op.path.slice(pathStart),
        ...(from
          ? { from: from.slice(from.indexOf("/", 1)) }
          : {}),
      } as PatchOp;
      const grouped = refOps.get(segments[0]!);
      if (grouped) grouped.push(relative);
      else refOps.set(segments[0]!, [relative]);
    }

    let didRefChange = false;
    const changedRefOps: PatchOp[] = [];
    for (const [field, patches] of refOps) {
      const loaded = (this as any)[field];
      if (loaded instanceof Model) {
        const previous = loaded.__data;
        const previousVersion = loaded[SYM_VERSION];
        loaded[SYM_SERVER_PATCH](patches);
        const effective = diff(previous, loaded.__data);
        if (loaded[SYM_VERSION] !== previousVersion) {
          didRefChange = true;
          changedRefOps.push(
            ...prefixPatchOps(field, effective.length > 0 ? effective : patches),
          );
        }
        continue;
      }
      if (!loaded || typeof loaded !== "object") continue;
      const next = patched(loaded, patches);
      const effective = diff(loaded, next);
      if (effective.length > 0) {
        this._installRefField(field, next);
        didRefChange = true;
        changedRefOps.push(...prefixPatchOps(field, effective));
      }
    }

    const previousVersion = this[SYM_VERSION];
    if (outerOps.length > 0) {
      const base: Record<string, any> = { ...this[SYM_SNAPSHOT] };
      const removedValueFields = new Set<string>();
      const removedRawFields = new Set<string>();
      for (const op of outerOps) {
        const segments = pointerSegments(op.path);
        if (op.op !== "remove" || segments.length !== 1) continue;
        const field = segments[0]!;
        if (field.startsWith("$") && this[SYM_REF_FIELDS].has(field.slice(1))) {
          removedRawFields.add(field.slice(1));
        } else if (this[SYM_REF_FIELDS].has(field)) {
          removedValueFields.add(field);
        }
      }
      const removedFields = new Set(
        [...removedValueFields].filter((field) => removedRawFields.has(field)),
      );
      for (const field of this[SYM_REF_FIELDS]) {
        const hasRawPatch = outerOps.some(
          (op) => pointerSegments(op.path)[0] === `$${field}`,
        );
        const clearsExpandedField = outerOps.some((op) => {
          const segments = pointerSegments(op.path);
          if (segments.length !== 1 || segments[0] !== field) return false;
          if (op.op === "remove") return true;
          return (op.op === "add" || op.op === "replace") && op.value == null;
        });
        if (!hasRawPatch && clearsExpandedField) {
          base[`$${field}`] = (this as any)[`$${field}`];
        }
      }
      const snapshot = patched(base, outerOps);
      for (const field of removedValueFields) {
        if (!removedFields.has(field)) snapshot[field] = null;
      }
      this[SYM_SERVER_MERGE](snapshot, undefined, removedFields);
    }
    if (didRefChange) {
      if (this[SYM_VERSION] === previousVersion) {
        (this as any)[SYM_VERSION] = previousVersion + 1;
        scheduleChangeEmit(this);
      }
      if (changedRefOps.length > 0) {
        this._emitOperations(changedRefOps, "remote");
      }
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
    for (const field of this[SYM_REF_FIELDS]) {
      if (Object.prototype.hasOwnProperty.call(out, field)) {
        out[`$${field}`] = out[field];
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

}

/**
 * Adds typed `$`-prefixed raw-id accessors for all reference fields.
 * The accessor installation in `_apply()` provides these at runtime —
 * this type just surfaces them to TypeScript so no casting is needed.
 *
 * The mapped type extracts the Model member from `Ref<Model> | null`, so
 * nullable refs still surface their `$field` accessor.
 * `any` is excluded so untyped JSON fields do not accidentally gain a
 * fictitious `$field` accessor. Nullable/optional refs include `null`; required
 * refs stay `string` so their model declaration remains the source of truth.
 */
type IsAny<T> = 0 extends 1 & T ? true : false;
/**
 * The Model half of a `Ref<X>` union. The projection member is dropped
 * by its `SYM_EXPANDED_REF` brand rather than by comparison against
 * `Model` or `ExpandedRef<...>`: either of those comparisons evaluates
 * the projection's mapped type, which re-enters the in-flight
 * instantiation on cyclic models and blows TS2589 at query call sites.
 */
type ModelMember<T> = Exclude<
  NonNullable<T>,
  string | { readonly [SYM_EXPANDED_REF]: true }
>;
/**
 * Detects a `Ref<X>` field: only ref unions carry full `string`
 * alongside a Model member. Deliberately shallow — see ModelMember.
 */
type ReferenceTarget<T> = IsAny<T> extends true
  ? never
  : string extends NonNullable<T>
    ? Extract<ModelMember<T>, Model>
    : never;

/**
 * Plain, potentially projected data carried by `.expand()`.
 *
 * Nested reference members map to their raw id: expansion is one-hop
 * only, so the wire row of an expanded value carries raw ids for its
 * own refs. Mapping them as `Ref<...>` would also make the type
 * self-referential for cyclic models (a parent ref to the same model,
 * or a two-model cycle), which blows TS2589 at query call sites. The
 * detector is `string extends member`: every `Ref<X>` union carries
 * plain `string`, and no other field shape does except a bare string
 * field, which the widening leaves semantically unchanged. Anything
 * that inspects the Model or ExpandedRef member here would re-enter
 * the in-flight instantiation on a cycle.
 */
export type ExpandedRef<T extends Model> = {
  // Base Model keys (every method plus id/timestamps) are excluded by
  // KEY, not by a `T[K] extends Function` value check: a value check
  // distributes over nested `Ref<...>` unions and instantiates each
  // linked model's ExpandedRef in turn, walking the entire model graph
  // and hitting the instantiation depth limit on any ref cycle. The
  // shared projection fields come back in the intersection below.
  [K in Exclude<keyof T, keyof Model> as K extends string
    ? K extends `__${string}`
      ? never
      : K
    : never]?: string extends NonNullable<T[K]>
    ? NonNullable<T[K]> extends string
      ? T[K]
      : string | null
    : T[K];
} & {
  id: string;
  type?: string;
  createdAt?: Date;
  updatedAt?: Date;
  readonly [SYM_EXPANDED_REF]: true;
};

/** A reference is a raw id, assigned Model, or inline wire projection. */
export type Ref<T extends Model> = T | ExpandedRef<T> | string;

export type WithRefs<T extends Model> = T & {
  // Base Model members (id, timestamps, every method) can never be
  // refs; excluding them upfront skips a ReferenceTarget evaluation
  // per inherited member per model, which is the bulk of this type's
  // instantiation cost across a large model graph.
  [K in Exclude<keyof T, keyof Model> as K extends string
    ? [ReferenceTarget<T[K]>] extends [never]
      ? never
      : `$${K}`
    : never]: null extends T[K]
    ? string | null
    : undefined extends T[K]
    ? string | null
    : string;
};
