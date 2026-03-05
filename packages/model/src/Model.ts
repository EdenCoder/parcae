/**
 * @parcae/model — Model Base Class
 *
 * The core of Parcae. Properties on the class ARE the schema.
 * Direct property access (no .get()/.set()), fully typed, with change tracking.
 *
 * Uses a Proxy to intercept property access:
 * - Data properties read/write to the internal store with change tracking
 * - Reference properties (other Models) return lazy-loading proxies
 * - $-prefixed access returns raw IDs for references
 * - Methods and internals pass through to the real instance
 *
 * @example
 * ```typescript
 * class Post extends Model {
 *   static type = "post" as const;
 *   user: User;
 *   title: string = "";
 *   body: PostBody;
 *   published: boolean = false;
 * }
 *
 * const post = await Post.findById("abc");
 * post.title           // string — typed
 * post.title = "New";  // change tracked
 * post.user            // User (lazy proxy)
 * post.$user           // "user_k8f2m9x" (raw ID)
 * await post.save();
 * ```
 */

import { EventEmitter } from "eventemitter3";
import ShortId from "short-unique-id";
import { applyPatch } from "fast-json-patch";
import type {
  ModelAdapter,
  ModelConstructor,
  ChangeSet,
  QueryChain,
  SchemaDefinition,
  PatchOp,
} from "./adapters/types.js";

// ─── ID Generation ───────────────────────────────────────────────────────────

const uid = new ShortId({ length: 20 });

export function generateId(): string {
  return uid.rnd();
}

// ─── Internal Symbols ────────────────────────────────────────────────────────

/** Properties that live on the Model instance, not in the data store */
const INTERNAL_KEYS = new Set([
  // Instance properties
  "__data",
  "__updates",
  "__patchingColumns",
  "__pendingKeys",
  "__isNew",
  "__saveTimer",
  "__debounceMs",
  "__adapter",
  // Methods
  "save",
  "patch",
  "remove",
  "refresh",
  "load",
  "sanitize",
  "constructor",
  "emit",
  "on",
  "off",
  "once",
  "removeListener",
  "removeAllListeners",
  "listeners",
  "listenerCount",
  // Meta
  "id",
  "type",
  "createdAt",
  "updatedAt",
  // Static access
  "prototype",
  "__proto__",
  // Symbol access
  "then",
  "toJSON",
  "valueOf",
  "toString",
  "inspect",
  Symbol.toPrimitive,
  Symbol.toStringTag,
  Symbol.iterator,
]);

// ─── Model Class ─────────────────────────────────────────────────────────────

export class Model extends EventEmitter {
  // ── Static ─────────────────────────────────────────────────────────

  /** The model type identifier. Used for table naming and routing. */
  static type: string = "";

  /** Optional explicit path. If not set, derived from type: /v1/{pluralize(type)} */
  static path?: string;

  /** Scope definitions for access control. */
  static scope?: {
    read?: (ctx: any) => any;
    create?: (ctx: any) => any;
    update?: (ctx: any) => any;
    delete?: (ctx: any) => any;
    patch?: (ctx: any) => any;
  };

  /** Index definitions. */
  static indexes?: (string | string[])[];

  /**
   * Whether the table is managed by Parcae. Set to false for externally
   * managed tables (e.g. Better Auth user/session tables).
   */
  static managed: boolean = true;

  /**
   * Schema definition resolved from RTTIST metadata at startup.
   * Maps property names to column types.
   * @internal
   */
  static __schema?: SchemaDefinition;

  /** The global adapter instance. Set via Model.use(). */
  private static __adapter: ModelAdapter | null = null;

  /** Set the global adapter. Called once at startup. */
  static use(adapter: ModelAdapter): void {
    Model.__adapter = adapter;
  }

  /** Get the global adapter. Throws if not set. */
  static getAdapter(): ModelAdapter {
    if (!Model.__adapter) {
      throw new Error(
        "No adapter set. Call Model.use(adapter) before using models.",
      );
    }
    return Model.__adapter;
  }

  // ── Static Query Methods ───────────────────────────────────────────

  /** Create a new model instance and optionally save it. */
  static create<T extends Model>(
    this: ModelConstructor<T>,
    data?: Record<string, any>,
  ): T {
    const instance = new this(Model.getAdapter(), {
      ...data,
      id: data?.id ?? generateId(),
    });
    (instance as any).__isNew = true;
    return instance;
  }

  /** Find a model by ID. */
  static findById<T extends Model>(
    this: ModelConstructor<T>,
    id: string,
  ): Promise<T | null> {
    return Model.getAdapter().findById(this, id);
  }

  /** Start a query chain with a where clause. */
  static where<T extends Model>(
    this: ModelConstructor<T>,
    ...args: any[]
  ): QueryChain<T> {
    return Model.getAdapter()
      .query(this)
      .where(...args);
  }

  /** Start a query chain with a raw where clause. */
  static whereRaw<T extends Model>(
    this: ModelConstructor<T>,
    query: string,
    ...bindings: any[]
  ): QueryChain<T> {
    return Model.getAdapter()
      .query(this)
      .whereRaw(query, ...bindings);
  }

  /** Start a query chain with whereIn. */
  static whereIn<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
    values: any[],
  ): QueryChain<T> {
    return Model.getAdapter().query(this).whereIn(column, values);
  }

  /** Start a query chain with whereNot. */
  static whereNot<T extends Model>(
    this: ModelConstructor<T>,
    ...args: any[]
  ): QueryChain<T> {
    return Model.getAdapter()
      .query(this)
      .whereNot(...args);
  }

  /** Start a query chain with whereNotIn. */
  static whereNotIn<T extends Model>(
    this: ModelConstructor<T>,
    column: string,
    values: any[],
  ): QueryChain<T> {
    return Model.getAdapter().query(this).whereNotIn(column, values);
  }

  /** Start a query chain with select. */
  static select<T extends Model>(
    this: ModelConstructor<T>,
    ...columns: string[]
  ): QueryChain<T> {
    return Model.getAdapter()
      .query(this)
      .select(...columns);
  }

  /** Count matching records. */
  static count<T extends Model>(this: ModelConstructor<T>): Promise<number> {
    return Model.getAdapter().query(this).count();
  }

  /** Convenience query: paginated, sorted. */
  static basic<T extends Model>(
    this: ModelConstructor<T>,
    limit?: number,
    sort?: string,
    direction?: "asc" | "desc",
    page?: number,
  ): QueryChain<T> {
    return Model.getAdapter().query(this).basic(limit, sort, direction, page);
  }

  // ── Instance ───────────────────────────────────────────────────────

  /** The internal data store. Frontend: Valtio proxy. Backend: plain object. */
  public __data: Record<string, any>;

  /** The adapter this instance was created with. */
  private __adapter: ModelAdapter;

  /** Property names that have been modified since last save. */
  private __updates: string[] = [];

  /** Columns currently being patched (in-flight PATCH ops). */
  private __patchingColumns: Set<string> = new Set();

  /** Combined set of pending keys (updates + patching) for optimistic UI. */
  get __pendingKeys(): ReadonlySet<string> {
    const keys = new Set(this.__updates);
    for (const col of this.__patchingColumns) keys.add(col);
    return keys;
  }

  /** Whether this is a newly created model not yet persisted. */
  private __isNew: boolean = false;

  /** Debounce timer for batched saves. */
  private __saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounce delay in ms. 0 = immediate (backend). 500 = batched (frontend). */
  public __debounceMs: number = 0;

  constructor(adapter: ModelAdapter, data?: Record<string, any>) {
    super();

    this.__adapter = adapter;

    // Initialize data store with defaults
    const initialData = {
      id: data?.id ?? generateId(),
      type: (this.constructor as typeof Model).type,
      createdAt: data?.createdAt ?? new Date().toISOString(),
      updatedAt: data?.updatedAt ?? new Date().toISOString(),
      ...data,
    };

    // Let the adapter create the store (Valtio proxy or plain object)
    this.__data = adapter.createStore(initialData);

    // Return a Proxy wrapping this instance
    return new Proxy(this, {
      get(target, prop, receiver) {
        // Symbol properties — pass through
        if (typeof prop === "symbol") {
          return Reflect.get(target, prop, receiver);
        }

        // Internal keys and methods — pass through to the real instance
        if (INTERNAL_KEYS.has(prop)) {
          return Reflect.get(target, prop, receiver);
        }

        // $-prefixed access — raw ID for reference properties
        if (typeof prop === "string" && prop.startsWith("$")) {
          const realKey = prop.slice(1);
          return target.__data[realKey];
        }

        // Check if this is a reference property (another Model class)
        const schema = (target.constructor as typeof Model).__schema;
        if (schema && prop in schema) {
          const colDef = schema[prop];
          if (
            typeof colDef === "object" &&
            colDef !== null &&
            "kind" in colDef &&
            colDef.kind === "ref"
          ) {
            // Reference property — return lazy-loading proxy
            const refId = target.__data[prop];
            if (!refId) return null;
            return target._createRefProxy(colDef.target, refId);
          }
        }

        // Check if property exists on data store
        if (prop in target.__data) {
          return target.__data[prop];
        }

        // Fall through to the real instance (for prototype methods, etc.)
        return Reflect.get(target, prop, receiver);
      },

      set(target, prop, value, receiver) {
        if (typeof prop === "symbol") {
          return Reflect.set(target, prop, value, receiver);
        }

        // Internal keys — set directly on the instance
        if (INTERNAL_KEYS.has(prop)) {
          return Reflect.set(target, prop, value, receiver);
        }

        // $-prefixed write — set raw ID
        if (typeof prop === "string" && prop.startsWith("$")) {
          const realKey = prop.slice(1);
          target.__data[realKey] = value;
          target.__updates.push(realKey);
          return true;
        }

        // Check if this is a reference — accept Model instance or string ID
        const schema = (target.constructor as typeof Model).__schema;
        if (schema && prop in schema) {
          const colDef = schema[prop];
          if (
            typeof colDef === "object" &&
            colDef !== null &&
            "kind" in colDef &&
            colDef.kind === "ref"
          ) {
            // If value is a Model instance, extract its ID
            if (value instanceof Model) {
              target.__data[prop] = value.id;
            } else {
              target.__data[prop] = value;
            }
            target.__updates.push(prop as string);
            return true;
          }
        }

        // Regular data property — set on the data store
        target.__data[prop as string] = value;
        target.__updates.push(prop as string);
        return true;
      },

      has(target, prop) {
        if (typeof prop === "string" && prop in target.__data) return true;
        return Reflect.has(target, prop);
      },

      ownKeys(target) {
        return [
          ...Object.keys(target.__data),
          ...Reflect.ownKeys(target),
        ].filter((key, index, arr) => arr.indexOf(key) === index);
      },
    });
  }

  // ── Accessors ────────────────────────────────────────────────────────

  /** The model's unique ID. */
  get id(): string {
    return this.__data.id;
  }

  /** The model type (from static type). */
  get type(): string {
    return (this.constructor as typeof Model).type;
  }

  /** Created timestamp. */
  get createdAt(): string {
    return this.__data.createdAt;
  }

  /** Updated timestamp. */
  get updatedAt(): string {
    return this.__data.updatedAt;
  }

  // ── Persistence ──────────────────────────────────────────────────────

  /**
   * Save pending changes to the adapter.
   * Supports debouncing for frontend batched saves.
   */
  async save(immediate?: boolean): Promise<void> {
    if (immediate || this.__debounceMs <= 0) {
      return this._flush();
    }

    // Debounced save
    if (this.__saveTimer) {
      clearTimeout(this.__saveTimer);
    }

    return new Promise<void>((resolve) => {
      this.__saveTimer = setTimeout(async () => {
        this.__saveTimer = null;
        await this._flush();
        resolve();
      }, this.__debounceMs);
    });
  }

  /** Flush all pending changes to the adapter. */
  private async _flush(): Promise<void> {
    const updates = [...this.__updates];
    this.__updates = [];

    if (updates.length === 0 && !this.__isNew) return;

    const changes: ChangeSet = {
      updates,
      ops: [],
      creating: this.__isNew,
    };

    // Update the timestamp
    this.__data.updatedAt = new Date().toISOString();

    await this.__adapter.save(this, changes);
    this.__isNew = false;
    this.emit("saved", this);
  }

  /**
   * Apply RFC 6902 JSON Patch operations.
   * Applies locally first (optimistic), then persists via adapter.
   */
  async patch(ops: PatchOp[]): Promise<void> {
    // Track which top-level columns are being patched
    const columns = new Set<string>();
    for (const op of ops) {
      const parts = op.path.split("/").filter(Boolean);
      if (parts[0]) columns.add(parts[0]);
    }

    // Add to patching columns (protects from stale server overwrites)
    for (const col of columns) {
      this.__patchingColumns.add(col);
    }

    try {
      // Apply locally first (optimistic)
      applyPatch(this.__data, ops, false, true);

      // Persist via adapter
      await this.__adapter.patch(this, ops);

      this.emit("patched", this);
    } finally {
      // Remove from patching columns
      for (const col of columns) {
        this.__patchingColumns.delete(col);
      }
    }
  }

  /** Delete this model. */
  async remove(): Promise<void> {
    await this.__adapter.remove(this);
    this.emit("removed", this);
  }

  /** Reload this model from the adapter. */
  async refresh(): Promise<void> {
    const ModelClass = this.constructor as ModelConstructor;
    const fresh = await this.__adapter.findById(ModelClass, this.id);
    if (fresh) {
      const freshData = (fresh as any).__data;
      for (const key of Object.keys(freshData)) {
        if (!this.__pendingKeys.has(key)) {
          this.__data[key] = freshData[key];
        }
      }
    }
  }

  /** Alias for refresh(). */
  async load(): Promise<void> {
    return this.refresh();
  }

  /**
   * Serialize for API response. Override in subclasses to strip sensitive fields.
   */
  async sanitize(_user?: { id: string }): Promise<Record<string, any>> {
    return {
      type: this.type,
      ...this.__data,
    };
  }

  /** JSON serialization. */
  toJSON(): Record<string, any> {
    return {
      type: this.type,
      ...this.__data,
    };
  }

  // ── Reference Proxy ──────────────────────────────────────────────────

  /** Cache for loaded reference proxies. */
  private static __refCache = new Map<string, any>();

  /**
   * Create a lazy-loading proxy for a reference property.
   * On first property access, loads the referenced model.
   */
  private _createRefProxy(targetClass: ModelConstructor, refId: string): any {
    const cacheKey = `${targetClass.type}:${refId}`;

    // Check cache first
    const cached = Model.__refCache.get(cacheKey);
    if (cached) return cached;

    // Create a lazy proxy
    let loaded: any = null;
    let loading: Promise<any> | null = null;

    const lazyProxy = new Proxy({} as any, {
      get(_target, prop) {
        // Allow ID access without loading
        if (prop === "id") return refId;
        if (prop === "type") return targetClass.type;
        if (prop === "then") return undefined; // Not a thenable
        if (prop === "toJSON")
          return () => ({ id: refId, type: targetClass.type });
        if (prop === Symbol.toPrimitive) return () => refId;

        // If already loaded, return from loaded instance
        if (loaded) {
          return (loaded as any)[prop];
        }

        // Start loading if not already
        if (!loading) {
          loading = Model.getAdapter()
            .findById(targetClass, refId)
            .then((result) => {
              loaded = result;
              Model.__refCache.set(cacheKey, loaded);
              return result;
            });
        }

        // Throw the promise for React Suspense
        throw loading;
      },
    });

    return lazyProxy;
  }
}

export default Model;
