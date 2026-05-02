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
 */

import { EventEmitter } from "eventemitter3";
import ShortId from "short-unique-id";
import { applyPatch, compare } from "fast-json-patch";
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
 * `"change"` iff something actually changed.
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

function lazyQuery<T>(
  modelClass: ModelConstructor<T>,
  steps: any[] = [],
): QueryChain<T> {
  const chain: any = {};

  for (const method of CHAINABLE_METHODS) {
    chain[method] = (...args: any[]) =>
      lazyQuery(modelClass, [...steps, { method, args }]);
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

  chain.__steps = steps;
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
function isArrayIndexSegment(seg: string | undefined): boolean {
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
function ensureIntermediates(
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

/** Return the set of top-level keys touched by a batch of ops. */
function topLevelKeys(ops: readonly PatchOp[]): Set<string> {
  const keys = new Set<string>();
  for (const op of ops) {
    const top = op.path.split("/")[1];
    if (top) keys.add(top);
    if ((op as any).from) {
      const fromTop = String((op as any).from).split("/")[1];
      if (fromTop) keys.add(fromTop);
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

  // ── Static ─────────────────────────────────────────────────────────

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

  private static _query<T extends Model>(
    this: ModelConstructor<T>,
  ): QueryChain<T> {
    return lazyQuery(this);
  }

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
    (instance as any)._apply();
    (instance as any).__isNew = true;
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
    (instance as any)._apply();
    (instance as any).__isNew = false;
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
    return (this as any)._query().where(...args);
  }

  static whereRaw<T extends Model>(
    this: ModelConstructor<T>,
    query: string,
    ...bindings: any[]
  ): QueryChain<WithRefs<T>> {
    return (this as any)._query().whereRaw(query, ...bindings);
  }

  static whereIn<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
    values: any[],
  ): QueryChain<WithRefs<T>> {
    return (this as any)._query().whereIn(column, values);
  }

  static whereNot<T extends Model>(
    this: ModelConstructor<T>,
    ...args: any[]
  ): QueryChain<WithRefs<T>> {
    return (this as any)._query().whereNot(...args);
  }

  static whereNotIn<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
    values: any[],
  ): QueryChain<WithRefs<T>> {
    return (this as any)._query().whereNotIn(column, values);
  }

  static select<T extends Model>(
    this: ModelConstructor<T>,
    ...columns: string[]
  ): QueryChain<WithRefs<T>> {
    return (this as any)._query().select(...columns);
  }

  static count<T extends Model>(this: ModelConstructor<T>): Promise<number> {
    return (this as any)._query().count();
  }

  static search<T extends Model>(
    this: ModelConstructor<T>,
    term: string,
  ): QueryChain<WithRefs<T>> {
    return (this as any)._query().search(term);
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
    // instance always has a stable id / timestamps.
    const nowIso = new Date().toISOString();
    (this as any).id = data.id ?? generateId();
    (this as any).type = (this.constructor as typeof Model).type;
    (this as any).createdAt = data.createdAt ?? nowIso;
    (this as any).updatedAt = data.updatedAt ?? nowIso;
    if (data.tmp !== undefined) (this as any).tmp = data.tmp;

    // Apply provided non-system data. These OVERWRITE subclass field
    // defaults because we're running after the subclass's field
    // initializers finished.
    for (const [key, value] of Object.entries(data)) {
      if (SYSTEM_DATA_KEYS.has(key)) continue;
      (this as any)[key] = value;
    }

    // Install per-field accessors for ref fields. Replaces whatever
    // the subclass's `declare` / data assignment put there with a
    // getter that returns a lazy-loading Model proxy and a setter
    // that accepts either a Model instance (stored as its id) or a
    // raw id string.
    const schema = (this.constructor as typeof Model).__schema;
    if (schema) {
      for (const [field, col] of Object.entries(schema)) {
        if (
          typeof col === "object" &&
          col !== null &&
          "kind" in col &&
          col.kind === "ref"
        ) {
          this._installRefField(field, col.target);
        }
      }
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
   *   post.author            → lazy-loading Model proxy
   *   post.author = user     → stores user.id
   *   post.author = "u_abc"  → stores "u_abc"
   *   post.$author           → "u_abc" (raw id, no load)
   *   post.$author = "u_xyz" → overwrites raw id
   */
  private _installRefField(field: string, targetClass: ModelConstructor): void {
    const initial = (this as any)[field];
    let raw: string | null =
      initial instanceof Model
        ? ((initial as any).id ?? null)
        : ((initial as string | null | undefined) ?? null);

    delete (this as any)[field];

    const self = this;
    Object.defineProperty(this, field, {
      configurable: true,
      enumerable: true,
      get() {
        if (!raw) return null;
        return self._createRefProxy(targetClass, raw);
      },
      set(value: Model | string | null | undefined) {
        raw =
          value instanceof Model
            ? ((value as any).id ?? null)
            : (value ?? null);
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
  async patch(ops: PatchOp[]): Promise<void> {
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

      (this as any)[SYM_VERSION] = ((this as any)[SYM_VERSION] ?? 0) + 1;
      this.emit("change");

      await this[SYM_ADAPTER].patch(this, ops);

      // Replay ops onto the snapshot so flush() won't re-emit them.
      const serverSnap = structuredClone(this[SYM_SNAPSHOT]);
      ensureIntermediates(serverSnap, ops);
      applyPatch(serverSnap, ops, false, true);
      this[SYM_SNAPSHOT] = serverSnap;

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
    const strip = (data: Record<string, any>): Record<string, any> => {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(data)) {
        if (SYSTEM_DATA_KEYS.has(k)) continue;
        out[k] = v;
      }
      return out;
    };
    const snap = JSON.parse(JSON.stringify(strip(this[SYM_SNAPSHOT] ?? {})));
    const current = JSON.parse(JSON.stringify(strip(this.__data)));
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
   *
   * Returns `this` so call sites that expected a "fresh instance" from
   * the previous Proxy-swapping design keep working unchanged.
   */
  [SYM_SERVER_MERGE](serverData: Record<string, any>): this {
    const pending = this[SYM_PATCHING];
    const serverKeys = new Set(Object.keys(serverData));
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
      if (!Object.is((this as any)[key], nextVal)) {
        (this as any)[key] = nextVal;
        didChange = true;
      }
    }

    // Delete keys the server no longer has. Same filter as __data so
    // we don't accidentally prune methods, EE internals, ref accessor
    // storage, or private state.
    for (const key of Object.keys(this)) {
      if (SYSTEM_DATA_KEYS.has(key)) continue;
      if (INSTANCE_METHODS.has(key)) continue;
      if (EVENTEMITTER_KEYS.has(key)) continue;
      if (key.startsWith("_") || key.startsWith("$")) continue;
      if (serverKeys.has(key)) continue;
      if (keyHasPending(key)) continue;
      delete (this as any)[key];
      didChange = true;
    }

    // Snapshot always refreshes — it represents what the server holds,
    // independent of local pending writes.
    this[SYM_SNAPSHOT] = structuredClone(serverData);

    if (didChange) {
      (this as any)[SYM_VERSION] = ((this as any)[SYM_VERSION] ?? 0) + 1;
      this.emit("change");
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

  async sanitize(_user?: { id: string }): Promise<Record<string, any>> {
    return { type: (this as any).type, ...this.__data };
  }

  toJSON(): Record<string, any> {
    return { type: (this as any).type, ...this.__data };
  }

  // ── Reference Proxy ──────────────────────────────────────────────────

  private static __refCache = new Map<
    string,
    { value: any; expires: number }
  >();
  private static REF_CACHE_TTL = 30_000; // 30 seconds

  private _createRefProxy(targetClass: ModelConstructor, refId: string): any {
    const cacheKey = `${targetClass.type}:${refId}`;
    const cached = Model.__refCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.value;
    if (cached) Model.__refCache.delete(cacheKey);

    let loaded: any = null;
    let loading: Promise<any> | null = null;

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
              Model.__refCache.set(cacheKey, {
                value: proxy,
                expires: Date.now() + Model.REF_CACHE_TTL,
              });
              return result;
            });
        }

        // React Suspense integration — throw the pending promise.
        throw loading;
      },
    });

    return proxy;
  }
}

/**
 * Adds typed `$`-prefixed string accessors for all reference fields.
 * The accessor installation in `_apply()` provides these at runtime —
 * this type just surfaces them to TypeScript so no casting is needed.
 */
export type WithRefs<T extends Model> = T & {
  [K in keyof T as T[K] extends Model ? `$${string & K}` : never]: string;
};

// Symbol declarations for TypeScript
declare module "./Model" {
  interface Model {
    [SYM_ADAPTER]: ModelAdapter;
    [SYM_PATCHING]: Set<string>;
    [SYM_SNAPSHOT]: Record<string, any>;
    [SYM_PENDING_DATA]?: Record<string, any>;
    [SYM_FLUSH_INFLIGHT]: Promise<void> | null | undefined;
    [SYM_FLUSH_TRAILING]: Promise<void> | null | undefined;
  }
}
