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
 * `useModel` / `useModelAtomic` subscribe to `"change"`; reference identity
 * across merges is stable.
 *
 * `stage()` / `patch()` / `flush()` emit synchronously (optimistic UI relies on
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
/** Per-field raw id, proxy, and loaded expanded instance. */


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

function lazyQuery<T>(
  modelClass: ModelConstructor<T>,
  steps: any[] = [],
  keySteps: any[] = [],
  capturedAdapter: ModelAdapter | null = getBoundAdapter(modelClass),
): QueryChain<T> {
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

  const resolve = async (): Promise<QueryChain<T>> => {
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

  chain.__steps = keySteps;
  chain.__modelType = modelClass.type;
  chain.__modelClass = modelClass;
  chain.__adapter = capturedAdapter;

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

/** Decode one RFC 6901 JSON Pointer segment. */
function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function pointerSegments(path: string): string[] {
  if (!path.startsWith("/")) return [];
  return path.slice(1).split("/").map(decodePointerSegment);
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
    const segments = pointerSegments(path);
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

function dataValuesEqual(left: any, right: any): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    left === undefined ||
    right === undefined ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  return compare(dateSafeClone(left), dateSafeClone(right)).length === 0;
}

function mergeServerWithLocalChanges(
  serverData: Record<string, any>,
  baselineData: Record<string, any>,
  currentData: Record<string, any>,
): Record<string, any> {
  const localOps = compare(
    dateSafeClone(baselineData),
    dateSafeClone(currentData),
  ) as unknown as PatchOp[];
  if (localOps.length === 0) return structuredClone(serverData);
  const merged = structuredClone(serverData);
  ensureIntermediates(merged, localOps);
  applyPatch(merged, localOps, false, true);
  return merged;
}

/** Return the set of top-level keys touched by a batch of ops. */
function topLevelKeys(ops: readonly PatchOp[]): Set<string> {
  const keys = new Set<string>();
  for (const op of ops) {
    const top = pointerSegments(op.path)[0];
    if (top !== undefined) keys.add(top);
    if (op.op === "copy" || op.op === "move") {
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
    return Model.getAdapter
      .call(this as unknown as typeof Model)
      .findById(this, id) as Promise<WithRefs<T> | null>;
  }

  static where<T extends Model>(
    this: ModelConstructor<T>,
    ...args: any[]
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).where(
      ...args
    ) as QueryChain<WithRefs<T>>;
  }

  static whereRaw<T extends Model>(
    this: ModelConstructor<T>,
    query: string,
    ...bindings: any[]
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).whereRaw(
      query,
      ...bindings
    ) as QueryChain<WithRefs<T>>;
  }

  static whereIn<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
    values: any[],
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).whereIn(
      column,
      values,
    ) as QueryChain<WithRefs<T>>;
  }

  static whereNot<T extends Model>(
    this: ModelConstructor<T>,
    ...args: any[]
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).whereNot(
      ...args
    ) as QueryChain<WithRefs<T>>;
  }

  static whereNotIn<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
    values: any[],
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).whereNotIn(
      column,
      values,
    ) as QueryChain<WithRefs<T>>;
  }

  static whereNull<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).whereNull(
      column,
    ) as QueryChain<WithRefs<T>>;
  }

  static whereNotNull<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).whereNotNull(
      column,
    ) as QueryChain<WithRefs<T>>;
  }

  static select<T extends Model>(
    this: ModelConstructor<T>,
    ...columns: string[]
  ): QueryChain<WithRefs<T>> {
    return lazyQuery(this, [], [], getBoundAdapter(this)).select(
      ...columns
    ) as QueryChain<WithRefs<T>>;
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
    return lazyQuery(this, [], [], getBoundAdapter(this)).search(
      term,
    ) as QueryChain<WithRefs<T>>;
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
    // Subclass field initializers like `author: Author | null = null`
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
    }
    for (const field of refFields) {
      this._installRefField(field, data[field] ?? (this as any)[field] ?? null);
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

    // Schema-free $key mirrors. Every non-ref, non-system field in
    // the payload gets `$key = raw_value` so callers can read the
    // wire value without a schema-derived ref accessor.
    // Ref fields already have `$key` as a getter from _installRefField
    // above, so skip them here.
    for (const [key, value] of Object.entries(data)) {
      if (SYSTEM_DATA_KEYS.has(key) || key.startsWith("$")) continue;
      if (refFields.has(key)) continue;
      (this as any)[`$${key}`] = value;
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
   *   post.author            → lazy-loading Model proxy (memoized on this field)
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
   * Suspense-throw on first access. The pre-population mints a fresh
   * field-local proxy, so no other instance or adapter can shadow it.
   * On any subsequent reassignment the cached proxy is cleared and
   * the lazy path resumes (correct: the new ref id may not have
   * been expanded).
   */
  private _installRefField(field: string, incoming: unknown): void {
    const v =
      incoming instanceof Model
        ? incoming
        : incoming && typeof incoming === "object" && typeof (incoming as any).id === "string"
        ? incoming
        : typeof incoming === "string"
        ? incoming || null
        : null;
    (this as any)[field] = v;
    if (!Object.getOwnPropertyDescriptor(this, `$${field}`)) {
      Object.defineProperty(this, `$${field}`, {
        configurable: true,
        enumerable: false,
        get(this: any) {
          const cur = this[field];
          return cur?.id ?? cur ?? null;
        },
        set(this: any, v: string | null | undefined) {
          this[field] = v ?? null;
        },
      });
    }
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
    return new Set(this[SYM_PATCHING].keys());
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
   * dirty-tracking — the adapter receives an immutable snapshot of the
   * document captured when save() was called.
   *
   * Runs the adapter's "save" pipeline (on the backend: "create" /
   * "save" hooks, full INSERT ... ON CONFLICT MERGE).
   */
  save(): Promise<void> {
    (this as any).updatedAt = new Date().toISOString();
    const data = structuredClone(this.__data);
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

    const expectedData = structuredClone(this.__data);
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
    // batch consistent. See `patch.ts:dedupOps` for the contract.
    const ops = structuredClone(dedupOps(rawOps)) as PatchOp[];
    if (ops.length === 0) return ops;

    // Apply locally on a plain-object snapshot (fast-json-patch
    // mutates in place), then copy the touched top-level keys back
    // onto `this`. We avoid applyPatch'ing `this` directly because
    // the instance carries methods / ref accessors / EE internals
    // that would confuse the walker.
    const snap = this.__data;
    ensureIntermediates(snap, ops);
    applyPatch(snap, ops, false, true);
    this._copyPatchedTopLevels(snap, ops);

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
    const snapshot = this[SYM_SNAPSHOT];
    for (const key of Object.keys(snapshot)) delete snapshot[key];
    for (const [key, value] of Object.entries(data)) {
      snapshot[key] = structuredClone(value);
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
   * All flushes share the same write lane as save() and patch(). A queued
   * flush computes its diff only after prior writes acknowledge, so it
   * captures edits made while those writes were awaiting the adapter.
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
  flush(): Promise<void> {
    return this._enqueueWrite(() => this._doFlush());
  }

  /** @internal — one-shot body of `flush()`. Computes the diff and
   * delegates directly to the active write lane. */
  private async _doFlush(): Promise<void> {
    if (this.__isNew) {
      (this as any).updatedAt = new Date().toISOString();
      return this._writeSave(structuredClone(this.__data));
    }

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
    const expectedData = structuredClone(this.__data);
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
  ): this {
    const previousEffectiveData =
      this.listenerCount("operations") > 0
        ? dateSafeClone(this.__data)
        : null;
    const sourceModel = serverValue instanceof Model ? serverValue : null;
    const incomingData: Record<string, any> = sourceModel
      ? sourceModel.__data
      : (serverValue as Record<string, any>);
    const schema = (this.constructor as typeof Model).__schema;
    const authoritativeData: Record<string, any> = {};

    for (const [key, value] of Object.entries(incomingData)) {
      const col = schema?.[key];
      if (
        col &&
        typeof col === "object" &&
        "kind" in col &&
        col.kind === "ref"
      ) {
        authoritativeData[key] =
          value instanceof Model
            ? value.id
            : value && typeof value === "object"
              ? (value as Record<string, any>).id ?? null
              : value;
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
      const col = schema?.[key];
      const isRef =
        col && typeof col === "object" && "kind" in col && col.kind === "ref";
      if (isRef) {
        let incoming: unknown = nextVal ?? null;
        if (dataValuesEqual(nextVal, authoritativeData[key])) {
          const source = sourceModel ? (sourceModel as any)[key] : incomingData[key];
          if (source instanceof Model || (source && typeof source === "object")) {
            incoming = source;
          }
        }
        const prev = (this as any)[`$${key}`];
        this._installRefField(key, incoming);
        if ((this as any)[`$${key}`] !== prev) didChange = true;
        continue;
      }

      if (!Object.is((this as any)[key], nextVal)) {
        (this as any)[key] = nextVal;
        didChange = true;
      }
    }

    for (const key of Object.keys(this)) {
      if (SYSTEM_DATA_KEYS.has(key)) continue;
      if (INSTANCE_METHODS.has(key)) continue;
      if (EVENTEMITTER_KEYS.has(key)) continue;
      if (key.startsWith("_") || key.startsWith("$")) continue;
      if (mergedKeys.has(key)) continue;
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

    const snapshot = this[SYM_SNAPSHOT];
    for (const key of Object.keys(snapshot)) {
      if (!serverKeys.has(key)) delete snapshot[key];
    }
    for (const [key, value] of Object.entries(authoritativeData)) {
      snapshot[key] = structuredClone(value);
    }

    if (didChange) {
      (this as any)[SYM_VERSION] = (this as any)[SYM_VERSION] + 1;
      if (previousEffectiveData) {
        const ops = compare(
          previousEffectiveData,
          dateSafeClone(this.__data),
        ) as unknown as PatchOp[];
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
      const isNestedRef = fieldVal instanceof Model;
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
    for (const [field, patches] of refOps) {
      const loaded = (this as any)[field];
      if (!(loaded instanceof Model)) continue;
      const previousVersion = loaded[SYM_VERSION];
      loaded[SYM_SERVER_PATCH](patches);
      if (loaded[SYM_VERSION] !== previousVersion) didRefChange = true;
    }

    const previousVersion = this[SYM_VERSION];
    if (outerOps.length > 0) {
      const snapshot = structuredClone(this[SYM_SNAPSHOT]);
      ensureIntermediates(snapshot, outerOps);
      applyPatch(snapshot, outerOps, false, true);
      this[SYM_SERVER_MERGE](snapshot);
    }
    if (didRefChange && this[SYM_VERSION] === previousVersion) {
      (this as any)[SYM_VERSION] = previousVersion + 1;
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
   * Shared proxy factory for lazy and expanded refs. The mutable control is
   * retained by the owning field so subscription patches and full fetches can
   * refresh a loaded instance without replacing either proxy or raw id.
   *
   * The trap shape stays identical between the two cases — iteration
   * safety still applies. Pre-hydration seeds the same field-local
   * proxy protocol used by lazy refs.
   */
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
