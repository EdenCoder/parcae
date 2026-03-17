/**
 * @parcae/model — Model Base Class
 *
 * The instance IS the data store. No separate __data object.
 * A Proxy wraps the instance for change tracking and ref resolution.
 * Class property defaults (title = "", published = false) work naturally
 * because they set directly on the instance which the Proxy intercepts.
 *
 * Internal state uses Symbol keys to avoid collisions with data properties.
 */

import { EventEmitter } from "eventemitter3";
import ShortId from "short-unique-id";
import { applyPatch } from "fast-json-patch";
import {
  CHAINABLE_METHODS,
  type ModelAdapter,
  type ModelConstructor,
  type ChangeSet,
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
const SYM_UPDATES = Symbol("parcae:updates");
const SYM_PATCHING = Symbol("parcae:patching");
const SYM_IS_NEW = Symbol("parcae:isNew");
const SYM_SAVE_TIMER = Symbol("parcae:saveTimer");
const SYM_DEBOUNCE = Symbol("parcae:debounceMs");
const SYM_IS_PROXY = Symbol("parcae:isProxy");
const SYM_INIT_DATA = Symbol("parcae:initData");

/**
 * Symbol used to atomically merge server-authoritative data onto a Model
 * instance, bypassing the Proxy set trap so that SYM_UPDATES (local
 * dirty-tracking) is not polluted. Skips any keys that have pending
 * local changes (SYM_UPDATES or SYM_PATCHING).
 *
 * Accessed via the Proxy get trap, which returns a closure over the raw
 * target so writes bypass the Proxy entirely.
 */
export const SYM_SERVER_MERGE = Symbol("parcae:serverMerge");

// ─── Keys that should NOT be treated as data ─────────────────────────────────

const INSTANCE_METHODS = new Set([
  "save",
  "patch",
  "remove",
  "refresh",
  "load",
  "sanitize",
  "toJSON",
  "_flush",
  "_createRefProxy",
  "constructor",
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

  // Terminal methods — resolve adapter here (async, waits if not set yet)
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

  // Internal metadata
  chain.__steps = steps;
  chain.__modelType = modelClass.type;
  chain.__modelClass = modelClass;
  chain.__adapter = null; // resolved lazily

  return chain as QueryChain<T>;
}

// ─── Keys ────────────────────────────────────────────────────────────────────

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

/** Properties that are part of the data but handled specially. */
const SYSTEM_DATA_KEYS = new Set(["id", "type", "createdAt", "updatedAt"]);

// ─── Model Class ─────────────────────────────────────────────────────────────

export class Model extends EventEmitter {
  // ── Instance (set dynamically in constructor) ─────────────────────

  declare id: string;
  declare createdAt: string;
  declare updatedAt: string;
  /** Temporary client-side ID for optimistic matching. Stored in JSONB overflow. */
  declare tmp?: string;

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
  //
  // These build lazy query chains that only resolve the adapter at
  // execution time (.find(), .first(), .count()). This allows you to
  // build queries before the adapter is set (e.g. in React component
  // bodies before the ParcaeProvider mounts).

  /** Build a lazy query chain for this model class. */
  private static _query<T extends Model>(
    this: ModelConstructor<T>,
  ): QueryChain<T> {
    const ModelClass = this;
    return lazyQuery(ModelClass);
  }

  static create<T extends Model>(
    this: ModelConstructor<T>,
    data?: Record<string, any>,
  ): T {
    const instance = new this(Model.getAdapter(), {
      ...data,
      id: data?.id ?? generateId(),
    });
    (instance as any)[SYM_IS_NEW] = true;
    return instance;
  }

  static findById<T extends Model>(
    this: ModelConstructor<T>,
    id: string,
  ): Promise<T | null> {
    return Model.getAdapter().findById(this, id);
  }

  static where<T extends Model>(
    this: ModelConstructor<T>,
    ...args: any[]
  ): QueryChain<T> {
    return (this as any)._query().where(...args);
  }

  static whereRaw<T extends Model>(
    this: ModelConstructor<T>,
    query: string,
    ...bindings: any[]
  ): QueryChain<T> {
    return (this as any)._query().whereRaw(query, ...bindings);
  }

  static whereIn<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
    values: any[],
  ): QueryChain<T> {
    return (this as any)._query().whereIn(column, values);
  }

  static whereNot<T extends Model>(
    this: ModelConstructor<T>,
    ...args: any[]
  ): QueryChain<T> {
    return (this as any)._query().whereNot(...args);
  }

  static whereNotIn<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
    values: any[],
  ): QueryChain<T> {
    return (this as any)._query().whereNotIn(column, values);
  }

  static select<T extends Model>(
    this: ModelConstructor<T>,
    ...columns: string[]
  ): QueryChain<T> {
    return (this as any)._query().select(...columns);
  }

  static count<T extends Model>(this: ModelConstructor<T>): Promise<number> {
    return (this as any)._query().count();
  }

  static search<T extends Model>(
    this: ModelConstructor<T>,
    term: string,
  ): QueryChain<T> {
    return (this as any)._query().search(term);
  }

  // ── Constructor ────────────────────────────────────────────────────

  constructor(adapter: ModelAdapter, data?: Record<string, any>) {
    super();

    // Set internal state via symbols (invisible to data property access)
    this[SYM_ADAPTER] = adapter;
    this[SYM_UPDATES] = [] as string[];
    this[SYM_PATCHING] = new Set<string>();
    this[SYM_IS_NEW] = false;
    this[SYM_SAVE_TIMER] = null;
    this[SYM_DEBOUNCE] = 0;
    this[SYM_IS_PROXY] = false;

    // Store the init data keys so the Proxy set trap knows which values
    // were explicitly provided (and shouldn't be overwritten by class
    // property defaults that run AFTER super() returns).
    const initDataKeys = new Set(data ? Object.keys(data) : []);
    this[SYM_INIT_DATA] = initDataKeys;

    // Set system data properties directly on the instance
    (this as any).id = data?.id ?? generateId();
    (this as any).type = (this.constructor as typeof Model).type;
    (this as any).createdAt = data?.createdAt ?? new Date().toISOString();
    (this as any).updatedAt = data?.updatedAt ?? new Date().toISOString();

    // Set all provided data on the instance BEFORE the Proxy wraps it.
    // These go directly on `this`, bypassing the Proxy.
    if (data) {
      for (const [key, value] of Object.entries(data)) {
        if (!SYSTEM_DATA_KEYS.has(key)) {
          (this as any)[key] = value;
        }
      }
    }

    // Return a Proxy for change tracking and ref resolution
    const proxy = new Proxy(this, {
      set(target, prop, value) {
        if (typeof prop === "symbol") {
          (target as any)[prop] = value;
          return true;
        }

        // EventEmitter internals — set directly, no tracking
        if (EVENTEMITTER_KEYS.has(prop)) {
          (target as any)[prop] = value;
          return true;
        }

        // Reference property — accept Model instance (extract ID) or raw value
        const schema = (target.constructor as typeof Model).__schema;
        if (schema && prop in schema) {
          const colDef = schema[prop];
          if (
            typeof colDef === "object" &&
            colDef !== null &&
            "kind" in colDef &&
            colDef.kind === "ref"
          ) {
            (target as any)[prop] =
              value instanceof Model ? (value as any).id : value;
            target[SYM_UPDATES].push(prop);
            return true;
          }
        }

        // $-prefixed write — raw ID for refs
        if (typeof prop === "string" && prop.startsWith("$")) {
          const realKey = prop.slice(1);
          (target as any)[realKey] = value;
          target[SYM_UPDATES].push(realKey);
          return true;
        }

        // During construction (before SYM_IS_PROXY is set), class property
        // initializers fire. If this key was explicitly provided in the
        // constructor data, don't let the default overwrite it.
        if (!target[SYM_IS_PROXY] && target[SYM_INIT_DATA]?.has(prop)) {
          // Skip — the explicit value is already set on the instance
          return true;
        }

        // Regular data property — set on the instance, track the change
        (target as any)[prop] = value;

        // Only track changes for data properties (not during construction)
        if (
          target[SYM_IS_PROXY] &&
          !SYSTEM_DATA_KEYS.has(prop) &&
          !INSTANCE_METHODS.has(prop)
        ) {
          target[SYM_UPDATES].push(prop);
        }

        return true;
      },

      get(target, prop) {
        // Return a closure that atomically merges server-authoritative
        // data onto this instance.  Writes directly to the raw target,
        // bypassing the Proxy set trap (no dirty-tracking pollution).
        // Skips keys with pending local changes (SYM_UPDATES / SYM_PATCHING).
        // Deletes keys that exist locally but are absent in the server
        // snapshot (unless they have pending local changes).
        // Returns a NEW Proxy around the same target so React.memo sees
        // a fresh reference while the underlying object (and its pending
        // local state) is preserved.
        if (prop === SYM_SERVER_MERGE) {
          return (serverData: Record<string, any>) => {
            const pendingUpdates = new Set(target[SYM_UPDATES]);
            const pendingPatches = target[SYM_PATCHING];
            const serverKeys = new Set(Object.keys(serverData));

            // Write new/changed values
            for (const key of serverKeys) {
              if (pendingUpdates.has(key) || pendingPatches.has(key)) continue;
              (target as any)[key] = serverData[key];
            }

            // Delete keys that the server no longer has
            for (const key of Object.keys(target)) {
              if (SYSTEM_DATA_KEYS.has(key)) continue;
              if (INSTANCE_METHODS.has(key)) continue;
              if (EVENTEMITTER_KEYS.has(key)) continue;
              if (key.startsWith("_")) continue;
              if (serverKeys.has(key)) continue;
              if (pendingUpdates.has(key) || pendingPatches.has(key)) continue;
              delete (target as any)[key];
            }

            // Return a new Proxy around the same target — new reference
            // identity for React.memo, same underlying data + pending state.
            return new Proxy(target, this);
          };
        }

        if (typeof prop === "symbol") {
          return (target as any)[prop];
        }

        // $-prefixed access — raw ID for reference properties
        if (typeof prop === "string" && prop.startsWith("$")) {
          const realKey = prop.slice(1);
          return (target as any)[realKey];
        }

        // Reference property — return lazy-loading proxy
        const schema = (target.constructor as typeof Model).__schema;
        if (schema && prop in schema) {
          const colDef = schema[prop];
          if (
            typeof colDef === "object" &&
            colDef !== null &&
            "kind" in colDef &&
            colDef.kind === "ref"
          ) {
            const refId = (target as any)[prop];
            if (!refId) return null;
            return target._createRefProxy(colDef.target, refId);
          }
        }

        return (target as any)[prop];
      },

      has(target, prop) {
        return prop in target;
      },

      // Class field initializers use [[DefineOwnProperty]], not [[Set]].
      // This trap intercepts them so we can skip defaults for keys that
      // were explicitly provided in the constructor data.
      defineProperty(target, prop, descriptor) {
        if (typeof prop === "symbol") {
          return Reflect.defineProperty(target, prop, descriptor);
        }

        // During construction: if this key was in init data, skip the default
        if (
          !target[SYM_IS_PROXY] &&
          target[SYM_INIT_DATA]?.has(prop as string)
        ) {
          return true;
        }

        // EventEmitter internals — define directly
        if (EVENTEMITTER_KEYS.has(prop)) {
          return Reflect.defineProperty(target, prop, descriptor);
        }

        // Normal data property — define it (this is a class field default)
        return Reflect.defineProperty(target, prop, descriptor);
      },
    });

    // SYM_IS_PROXY starts false (set earlier). Property initializers from the
    // subclass run after this return, setting defaults on the proxy. The set
    // trap skips change tracking when SYM_IS_PROXY is false. After construction
    // completes, the first explicit write flips it to true via a lazy check.
    //
    // But we need a way to flip it. Use a microtask: by the time any user code
    // runs (which is async or at least after the constructor call), the
    // microtask will have fired.
    const target = this;
    queueMicrotask(() => {
      target[SYM_IS_PROXY] = true;
      delete (target as any)[SYM_INIT_DATA];
    });

    return proxy;
  }

  // ── Data Access (for adapters/serialization) ──────────────────────

  /**
   * Get all data properties as a plain object.
   * Used by adapters for serialization. Excludes methods, symbols, and EE internals.
   */
  get __data(): Record<string, any> {
    const data: Record<string, any> = {};
    for (const key of Object.keys(this)) {
      if (EVENTEMITTER_KEYS.has(key)) continue;
      if (INSTANCE_METHODS.has(key)) continue;
      if (key.startsWith("_")) continue;
      data[key] = (this as any)[key];
    }
    return data;
  }

  /**
   * Set data properties from a plain object (used by adapters during hydration).
   */
  set __data(data: Record<string, any>) {
    for (const [key, value] of Object.entries(data)) {
      (this as any)[key] = value;
    }
  }

  /** @internal */
  get __updates(): string[] {
    return this[SYM_UPDATES];
  }
  set __updates(v: string[]) {
    this[SYM_UPDATES] = v;
  }

  /** @internal */
  get __isNew(): boolean {
    return this[SYM_IS_NEW];
  }
  set __isNew(v: boolean) {
    this[SYM_IS_NEW] = v;
  }

  /** @internal */
  get __debounceMs(): number {
    return this[SYM_DEBOUNCE];
  }
  set __debounceMs(v: number) {
    this[SYM_DEBOUNCE] = v;
  }

  /** @internal */
  get __patchingColumns(): Set<string> {
    return this[SYM_PATCHING];
  }

  /** @internal */
  get __pendingKeys(): ReadonlySet<string> {
    const keys = new Set(this[SYM_UPDATES]);
    for (const col of this[SYM_PATCHING]) keys.add(col);
    return keys;
  }

  // ── Persistence ──────────────────────────────────────────────────────

  async save(immediate?: boolean): Promise<void> {
    if (immediate || this[SYM_DEBOUNCE] <= 0) {
      return this._flush();
    }

    if (this[SYM_SAVE_TIMER]) clearTimeout(this[SYM_SAVE_TIMER]);

    return new Promise<void>((resolve) => {
      this[SYM_SAVE_TIMER] = setTimeout(async () => {
        this[SYM_SAVE_TIMER] = null;
        await this._flush();
        resolve();
      }, this[SYM_DEBOUNCE]);
    });
  }

  private async _flush(): Promise<void> {
    const updates = [...this[SYM_UPDATES]];
    this[SYM_UPDATES] = [];

    if (updates.length === 0 && !this[SYM_IS_NEW]) return;

    const changes: ChangeSet = {
      updates,
      ops: [],
      creating: this[SYM_IS_NEW],
    };

    (this as any).updatedAt = new Date().toISOString();

    await this[SYM_ADAPTER].save(this, changes);
    this[SYM_IS_NEW] = false;
    this.emit("saved", this);
  }

  async patch(ops: PatchOp[]): Promise<void> {
    const columns = new Set<string>();
    for (const op of ops) {
      const parts = op.path.split("/").filter(Boolean);
      if (parts[0]) columns.add(parts[0]);
    }

    for (const col of columns) this[SYM_PATCHING].add(col);

    try {
      // Apply locally (optimistic) — build a data object for applyPatch
      const localData = this.__data;

      // Ensure intermediate objects exist for nested paths
      for (const op of ops) {
        const segments = op.path.split("/").filter(Boolean);
        let cursor: any = localData;
        for (let i = 0; i < segments.length - 1; i++) {
          const seg = segments[i]!;
          if (cursor[seg] == null) cursor[seg] = {};
          cursor = cursor[seg];
        }
      }

      applyPatch(localData, ops, false, true);
      // Write patched values back
      for (const col of columns) {
        if (col in localData) (this as any)[col] = localData[col];
      }

      await this[SYM_ADAPTER].patch(this, ops);
      this.emit("patched", this);
    } finally {
      for (const col of columns) this[SYM_PATCHING].delete(col);
    }
  }

  async remove(): Promise<void> {
    await this[SYM_ADAPTER].remove(this);
    this.emit("removed", this);
  }

  async refresh(): Promise<void> {
    const ModelClass = this.constructor as ModelConstructor;
    const fresh = await this[SYM_ADAPTER].findById(
      ModelClass,
      (this as any).id,
    );
    if (fresh) {
      const freshData = (fresh as any).__data;
      // Use SYM_SERVER_MERGE to write directly to the target, bypassing
      // the Proxy set trap so we don't pollute SYM_UPDATES.
      const merge = (this as any)[SYM_SERVER_MERGE];
      if (merge) {
        merge(freshData);
      }
    }
  }

  async sanitize(_user?: { id: string }): Promise<Record<string, any>> {
    return { type: (this as any).type, ...this.__data };
  }

  toJSON(): Record<string, any> {
    return { type: (this as any).type, ...this.__data };
  }

  // ── Reference Proxy ──────────────────────────────────────────────────

  private static __refCache = new Map<string, { value: any; expires: number }>();
  private static REF_CACHE_TTL = 30_000; // 30 seconds

  private _createRefProxy(targetClass: ModelConstructor, refId: string): any {
    const cacheKey = `${targetClass.type}:${refId}`;
    const cached = Model.__refCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.value;
    // Expired — remove stale entry
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

        throw loading;
      },
    });

    return proxy;
  }
}

// Symbol declarations for TypeScript
declare module "./Model" {
  interface Model {
    [SYM_ADAPTER]: ModelAdapter;
    [SYM_UPDATES]: string[];
    [SYM_PATCHING]: Set<string>;
    [SYM_IS_NEW]: boolean;
    [SYM_SAVE_TIMER]: ReturnType<typeof setTimeout> | null;
    [SYM_DEBOUNCE]: number;
    [SYM_IS_PROXY]: boolean;
    [SYM_INIT_DATA]: Set<string> | undefined;
  }
}
