import { log } from "../logger";
import { detectEngine } from "./engine";
import { loadCachedSchemas } from "../schema/generate";

/**
 * BackendAdapter — Knex + Postgres persistence for Parcae Model.
 *
 * Extracted from Dollhouse Studio's adapters/model.ts (829 lines).
 * Adapted to use RTTIST-resolved schemas instead of static columns,
 * and Parcae's hook/pubsub systems.
 */

import {
  CHAINABLE_METHODS,
  type ColumnType,
  type ModelAdapter,
  type ModelConstructor,
  type QueryChain,
  type QueryStep,
  type SchemaDefinition,
} from "@parcae/model";
import { generateId, type Model } from "@parcae/model";
import equal from "deep-equal";
import fastJsonPatch from "fast-json-patch";
import type { Operation as PatchOp } from "fast-json-patch";
const { applyPatch } = fastJsonPatch;
import pluralize from "pluralize";
import { ClientError } from "../helpers";
import type { HookAction, HookTiming } from "../routing/hook";
import { getHooksFor, hook } from "../routing/hook";
import {
  enqueue as globalEnqueue,
  lock as globalLock,
  getRequestUser,
} from "../services/context";
import type { ModelChangeBus } from "../services/model-change-bus";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BackendServices {
  read: any; // Knex read replica
  write: any; // Knex primary
  pubsub?: any; // Redis pub/sub + lock (optional)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tableName(modelClass: ModelConstructor): string {
  return pluralize(modelClass.type);
}

/** Resolve a ColumnType to a primitive string type. */
function resolveColType(col: ColumnType): string {
  if (typeof col === "string") return col;
  if (col.kind === "ref") return "string"; // refs stored as VARCHAR ID
  return "json";
}

/**
 * RFC 6901 array-index segment: numeric string (`"0"`, `"12"`) or
 * the append marker `"-"`. When the NEXT path segment after a
 * missing intermediate is one of these, the intermediate must be a
 * JSONB array, not an object — otherwise a downstream `for…of`
 * over the JS-side hydrated value would crash with "object is not
 * iterable" when the same field is later read back.
 */
function isArrayIndexSegment(seg: string | undefined): boolean {
  return seg === "-" || (seg !== undefined && /^\d+$/.test(seg));
}

/**
 * Hydrate a DB row into a Model instance.
 * Unpacks the `data` JSONB overflow column into top-level fields and
 * delegates to `Model.hydrate` so field-initializer defaults don't
 * clobber the data coming from the DB.
 *
 * Overflow-merge ordering
 * ───────────────────────
 * Declared schema columns are the source of truth. The `data` JSONB
 * overflow is only allowed to fill keys that don't have a column. This
 * matters whenever a column is promoted from overflow to first-class
 * after rows already exist in production: the migration adds the
 * column with whatever value `serialize()` writes to it, but the old
 * value lingers in the `data` blob too. Without this filter, the next
 * `PATCH` would update the column → readback would `Object.assign` the
 * stale JSON copy back over the new column value → the change appears
 * to revert. `save()` rewrites the blob and resolves the drift, but
 * `patch()` is incremental and never touches `data`.
 */
function hydrate<T>(
  modelClass: ModelConstructor<T>,
  adapter: BackendAdapter,
  row: Record<string, any>,
): T {
  const data = { ...row };
  const schema = modelClass.__schema as SchemaDefinition | undefined;

  // Unpack JSONB overflow column. Schema-known keys are skipped so a
  // stale snapshot in the blob can't override a column we just wrote.
  let overflow: Record<string, any> | null = null;
  if (typeof data.data === "string") {
    try {
      overflow = JSON.parse(data.data) ?? null;
    } catch {
      overflow = null;
    }
  } else if (typeof data.data === "object" && data.data !== null) {
    overflow = data.data as Record<string, any>;
  }
  if (overflow && typeof overflow === "object") {
    for (const [key, value] of Object.entries(overflow)) {
      if (schema && key in schema) continue;
      data[key] = value;
    }
  }
  delete data.data;

  // Coerce per-column types from the row shape we get back from Knex.
  // - datetime: ISO strings → Date instances
  // - json:     SQLite stores these as TEXT, so they come back as strings
  //             (Postgres jsonb arrives pre-parsed, so we no-op there).
  if (schema) {
    for (const [key, colDef] of Object.entries(schema)) {
      const t = resolveColType(colDef);
      const val = data[key];
      if (t === "datetime" && val) {
        data[key] = new Date(val);
      } else if (t === "json" && typeof val === "string" && val.length > 0) {
        try {
          data[key] = JSON.parse(val);
        } catch {
          // Leave as-is if it's not valid JSON — better than crashing.
        }
      }
    }
  }

  // Ensure timestamps
  data.createdAt = data.createdAt ? new Date(data.createdAt) : new Date();
  data.updatedAt = data.updatedAt ? new Date(data.updatedAt) : new Date();

  // Static `hydrate` is declared on Model itself but not on the
  // ModelConstructor interface (it's the constructor's job from the
  // adapter's POV). Cast to `any` for this single invocation — every
  // Model subclass inherits the static so the call is sound.
  return (modelClass as any).hydrate(adapter, data) as T;
}

/**
 * Serialize model data for DB insert/update.
 * Splits into declared columns + overflow `data` JSONB blob.
 */
function serialize(model: any): Record<string, any> {
  const ModelClass = model.constructor as typeof Model;
  const schema =
    (ModelClass.__schema as SchemaDefinition | undefined) ?? {};
  const raw = model.__data;

  if (!model.id) {
    (model as any).id = generateId();
  }

  const row: Record<string, any> = {
    id: model.id,
    createdAt: raw.createdAt || new Date(),
    updatedAt: new Date(),
    tmp: raw.tmp || null,
  };

  const overflow: Record<string, any> = {};
  const systemKeys = new Set(["id", "createdAt", "updatedAt", "type", "tmp"]);

  for (const [key, value] of Object.entries(raw)) {
    if (systemKeys.has(key)) continue;
    if (key in schema) {
      const colType = resolveColType(schema[key]!);
      if (colType === "json" && value != null) {
        row[key] = JSON.stringify(value);
      } else if (colType === "datetime" && value != null) {
        row[key] = new Date(value as string);
      } else {
        row[key] = value;
      }
    } else {
      overflow[key] = value;
    }
  }

  row.data = JSON.stringify(overflow);
  return row;
}

// ─── BackendAdapter ──────────────────────────────────────────────────────────

export class BackendAdapter implements ModelAdapter {
  private services: BackendServices;
  public subscriptions: any | null = null;
  public modelChangeBus: ModelChangeBus | null = null;

  /** Registered model constructors, keyed by type. Set via registerModels(). */
  private _models = new Map<string, ModelConstructor>();

  /** Detected database engine — set by detectEngine(). */
  public engine: "alloydb" | "postgres" | "sqlite" = "postgres";

  /** Whether search extensions have been enabled for this database. */
  private _searchExtensionsReady = false;

  /** Tables that have a verified _embedding column (AlloyDB only). */
  private _embeddingReady = new Set<string>();

  get read() {
    return this.services.read;
  }
  get write() {
    return this.services.write;
  }
  get pubsub() {
    return this.services.pubsub;
  }

  constructor(services: BackendServices) {
    this.services = services;
  }

  /**
   * Register model constructors so the adapter can resolve refs by type
   * AND attach `__schema` onto each model class from the on-disk
   * `.parcae/schema.json` cache when available.
   *
   * Why we read the cache here, unconditionally: the schema is a
   * read-only artifact — it tells us how each column is typed (string,
   * number, json, …) — and several adapter code paths *require* it to
   * make correct decisions (json-array `whereIn` dispatch, ref-field
   * dot-notation rewriting, …). Without it, server-side query builds
   * silently fall through to broken SQL even though the cache is
   * sitting on disk.
   *
   * Schema *generation* (running ts-morph against source files,
   * writing the cache) and *DDL* (CREATE TABLE / migrations) stay
   * opt-in via `generateSchemas()` and `ensureAllTables()` — they're
   * write-side operations and live downstream of registration.
   *
   * If `__schema` was already set on a model (e.g. an explicit prior
   * call to `generateSchemas()` or a manual override in a test), we
   * leave it alone.
   */
  registerModels(
    models: ModelConstructor[],
    options: { projectRoot?: string } = {},
  ): void {
    for (const m of models) {
      this._models.set(m.type, m);
    }
    this._attachCachedSchemas(models, options.projectRoot ?? process.cwd());
  }

  private _attachCachedSchemas(
    models: ModelConstructor[],
    projectRoot: string,
  ): void {
    const cached = loadCachedSchemas(projectRoot);
    if (!cached) return;
    const modelsByType = new Map(models.map((m) => [m.type, m] as const));
    const modelsByName = new Map(models.map((m) => [m.name, m] as const));
    for (const [type, schema] of Object.entries(cached)) {
      const ModelClass = modelsByType.get(type);
      if (!ModelClass) continue;
      // Don't clobber a schema that's already attached.
      if (ModelClass.__schema) continue;
      ModelClass.__schema = schema;
    }
    // Wire ref targets — the cache stores them as `{ type: "Name" }`
    // stubs (constructor references aren't JSON-serializable); resolve
    // them to the actual constructors registered in this adapter.
    for (const [, ModelClass] of modelsByType) {
      const schema = ModelClass.__schema as
        | SchemaDefinition
        | undefined;
      if (!schema) continue;
      for (const [key, colDef] of Object.entries(schema)) {
        if (
          typeof colDef === "object" &&
          colDef !== null &&
          "kind" in colDef &&
          colDef.kind === "ref"
        ) {
          const targetName = colDef.target?.type;
          const target =
            modelsByName.get(targetName) ?? modelsByType.get(targetName);
          // The schema is a Record<string, ColumnType>; the assignment
          // satisfies the type but writing a fresh ref entry needs an
          // index signature widening. Cast once at the write site —
          // the read shape stays typed.
          const typed = schema as Record<string, ColumnType>;
          if (target) typed[key] = { kind: "ref", target };
          else typed[key] = "string";
        }
      }
    }
  }

  // ── Engine Detection ────────────────────────────────────────────────

  /**
   * Detect database engine: SQLite, AlloyDB, or standard Postgres.
   * Should be called once at startup, before ensureAllTables().
   * Pass hint="sqlite" when the Knex client is better-sqlite3.
   */
  async detectEngine(
    hint?: "sqlite",
  ): Promise<"alloydb" | "postgres" | "sqlite"> {
    this.engine = await detectEngine(this.write, hint);
    log.info(`Database engine detected: ${this.engine}`);
    return this.engine;
  }

  /** Whether the engine is SQLite. */
  get isSqlite(): boolean {
    return this.engine === "sqlite";
  }

  // ── Search Extensions ───────────────────────────────────────────────

  /**
   * Enable search extensions (idempotent). Called once when the first
   * model with `static searchFields` is encountered during ensureTable().
   * No-op for SQLite (uses LIKE fallback instead).
   */
  private async _ensureSearchExtensions(): Promise<void> {
    if (this._searchExtensionsReady) return;
    if (this.isSqlite) {
      this._searchExtensionsReady = true;
      return;
    }

    // Standard Postgres — trigram fuzzy matching
    await this.write.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    log.info("Extension enabled: pg_trgm");

    if (this.engine === "alloydb") {
      await this.write.raw("CREATE EXTENSION IF NOT EXISTS vector");
      await this.write.raw(
        "CREATE EXTENSION IF NOT EXISTS alloydb_scann CASCADE",
      );
      await this.write.raw(
        "CREATE EXTENSION IF NOT EXISTS google_ml_integration",
      );
      log.info(
        "Extensions enabled: vector, alloydb_scann, google_ml_integration",
      );
    }

    this._searchExtensionsReady = true;
  }

  private _notifyChange(model: any): void {
    const ModelClass = model.constructor as typeof Model;
    // ModelChangeBus runs the local fast-path AND broadcasts to other
    // replicas. When the bus is not wired (e.g. test setups that mount
    // the adapter without app.ts), fall back to direct local dispatch
    // so existing per-adapter tests keep working.
    if (this.modelChangeBus) {
      this.modelChangeBus.notify(ModelClass.type);
    } else {
      this.subscriptions?.onModelChange(ModelClass.type);
    }
  }

  // ── Search Query ────────────────────────────────────────────────────

  /**
   * Apply hybrid search SQL to a Knex query builder.
   * Combines full-text (tsvector), fuzzy (trigram), and optionally
   * semantic (vector cosine) search with weighted ranking.
   */
  _applySearch(
    knexQuery: any,
    term: string,
    modelClass: ModelConstructor,
  ): any {
    const searchFields = modelClass.searchFields as string[];
    if (!searchFields?.length || !term.trim()) return knexQuery;

    const table = tableName(modelClass);

    // ── SQLite: LIKE-based fallback ─────────────────────────────────
    if (this.isSqlite) {
      const likeTerm = `%${term}%`;
      const whereParts = searchFields.map((f) => `${table}.${f} LIKE ?`);
      const whereBindings = searchFields.map(() => likeTerm);
      return knexQuery.whereRaw(`(${whereParts.join(" OR ")})`, whereBindings);
    }

    // ── Postgres: full-text + trigram + optional vector ──────────────

    // Build the ranking expression
    // 1. Full-text rank (weight: 2x)
    const rankParts: string[] = [
      `ts_rank(${table}._search, websearch_to_tsquery('english', ?)) * 2`,
    ];
    const rankBindings: any[] = [term];

    // 2. Trigram similarity — best across all search fields (weight: 1x)
    const simParts = searchFields.map((f) => `similarity(${table}.${f}, ?)`);
    rankParts.push(`greatest(${simParts.join(", ")})`);
    for (const _f of searchFields) rankBindings.push(term);

    // 3. Semantic similarity on AlloyDB (weight: 3x)
    // Only include vector search if the _embedding column was created for this table
    const useVector =
      this.engine === "alloydb" && this._embeddingReady.has(table);
    if (useVector) {
      rankParts.push(
        `(1.0 - (${table}._embedding <=> embedding('gemini-embedding-001', ?)::vector)) * 3`,
      );
      rankBindings.push(term);
    }

    const rankExpr = rankParts.join(" + ");

    // Build the WHERE clause — match on any of the search methods
    const whereParts: string[] = [
      `${table}._search @@ websearch_to_tsquery('english', ?)`,
    ];
    const whereBindings: any[] = [term];

    for (const f of searchFields) {
      whereParts.push(`${table}.${f} % ?`);
      whereBindings.push(term);
    }

    if (useVector) {
      whereParts.push(
        `${table}._embedding <=> embedding('gemini-embedding-001', ?)::vector < 0.7`,
      );
      whereBindings.push(term);
    }

    const whereExpr = whereParts.join(" OR ");

    return knexQuery
      .whereRaw(`(${whereExpr})`, whereBindings)
      .select(
        this.write.raw(`${table}.*, (${rankExpr}) AS _rank`, rankBindings),
      )
      .clearOrder()
      .orderByRaw("_rank DESC");
  }

  // ── createStore ──────────────────────────────────────────────────────

  createStore(data: Record<string, any>): Record<string, any> {
    return data; // Plain object on backend — no Valtio proxy
  }

  // ── save ─────────────────────────────────────────────────────────────

  /**
   * Upsert the entire current state of `model`. The `__isNew` flag (set
   * by `Model.create()`, cleared after the first successful save or by
   * `hydrate()`) controls hook routing: new instances run "create" /
   * "save" hooks, existing instances run "save" hooks only.
   *
   * Targeted RFC 6902 updates go through `.patch()` instead; this path
   * is intentionally "replace the whole row".
   */
  async save(model: any): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);
    const creating = Boolean((model as any).__isNew);

    const action = creating ? "create" : "save";
    const cleanups: Array<() => Promise<void> | void> = [];

    try {
      await this.runHooks(model, action, "before", { cleanups });

      (model as any).updatedAt = new Date();
      if (creating && !(model as any).createdAt) {
        (model as any).createdAt = new Date();
      }

      const row = serialize(model);
      await this.write(table).insert(row).onConflict("id").merge();

      await this.runHooks(model, action, "after", { cleanups });
    } catch (err) {
      await this._runCleanups(cleanups, `${ModelClass.type}:${action}`);
      throw err;
    }

    log.info(`model saved model=${ModelClass.type}, id=${model.id}`);
    this._notifyChange(model);
  }

  // ── remove ───────────────────────────────────────────────────────────

  async remove(model: any): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);
    const cleanups: Array<() => Promise<void> | void> = [];

    try {
      await this.runHooks(model, "remove", "before", { cleanups });
      await this.write(table).where("id", model.id).del();
      await this.runHooks(model, "remove", "after", { cleanups });
    } catch (err) {
      await this._runCleanups(cleanups, `${ModelClass.type}:remove`);
      throw err;
    }

    this._notifyChange(model);
  }

  // ── findById ─────────────────────────────────────────────────────────

  async findById<T>(
    modelClass: ModelConstructor<T>,
    id: string,
  ): Promise<T | null> {
    if (!id) return null;
    const row = await this.read(tableName(modelClass))
      .select("*")
      .where("id", id)
      .first();
    return row ? hydrate(modelClass, this, row) : null;
  }

  // ── query ────────────────────────────────────────────────────────────

  query<T>(modelClass: ModelConstructor<T>): QueryChain<T> {
    return this._buildQuery(modelClass, this.read(tableName(modelClass)));
  }

  // ── queryFromClient — safe replay of client-sent __query steps ────────

  /**
   * Build a scoped query from client-sent QueryStep[].
   *
   * Security model:
   *  1. Scope is always applied first (non-negotiable).
   *  2. Only whitelisted methods are replayed.
   *  3. Column names are validated against the model schema.
   *  4. A default limit is injected if the client omits one — clients
   *     that want more must call `.limit(N)` explicitly with the exact
   *     ceiling they need (or `.clearLimit()` to opt out entirely).
   *
   * No upper clamp on client-provided limits. The scope is the security
   * boundary — it already restricts which rows the client can see; a
   * row ceiling on top of that is defense-in-depth that mostly just
   * silently truncates legitimate queries and forces callers to add
   * `.clearLimit()` everywhere.
   *
   * Throws on invalid column references (fail loud during development).
   */

  private static SAFE_CLIENT_METHODS = new Set([
    "select",
    "search",
    "where",
    "andWhere",
    "orWhere",
    "whereIn",
    "whereNot",
    "whereNotIn",
    "whereNull",
    "whereNotNull",
    "whereBetween",
    "orderBy",
    "limit",
    "offset",
    "clearLimit",
  ]);

  /** Methods whose first arg is a column name (or object of column→value). */
  private static COLUMN_ARG_METHODS = new Set([
    "where",
    "andWhere",
    "orWhere",
    "whereIn",
    "whereNot",
    "whereNotIn",
    "whereNull",
    "whereNotNull",
    "whereBetween",
    "orderBy",
  ]);

  /** Operators safe for 3-arg where clauses. */
  private static SAFE_OPERATORS = new Set([
    "=",
    "!=",
    "<>",
    "<",
    ">",
    "<=",
    ">=",
    "like",
    "ilike",
    "not like",
    "not ilike",
    "in",
    "not in",
    "is",
    "is not",
    "@>",
  ]);

  /**
   * Default limit injected when a client query has no `.limit()` call.
   * Bounded enough to prevent an unbounded sequential-scan from a
   * scope-wide `Model.where(...).find()` with no pagination. Clients
   * that want more set an explicit `.limit(N)` (no upper clamp) or
   * `.clearLimit()` to disable the injection.
   */
  private static DEFAULT_LIMIT = 25;

  /**
   * Per-modelClass cache of "which `json` columns are actually arrays?".
   *
   * The schema resolver collapses both `string[]` and arbitrary objects
   * into the same `"json"` ColumnType, so we can't tell at the schema
   * layer whether a column was declared as `tags: string[] = []` or
   * `metadata: any = null`. We discover this by probing a fresh model
   * instance once and remembering the answer. WeakMap keys the cache by
   * constructor so it never holds a class alive past unloading.
   */
  /**
   * Decide whether `whereIn(col, vals)` should dispatch to JSONB
   * containment SQL.
   *
   * Schema-only check: if the resolved column type is `"json"`, we
   * assume the column stores an array (the only `whereIn` shape that
   * makes any sense — `whereIn("metadata", [{...}])` on a json-object
   * column is meaningless either way). The decision is purely
   * declarative — no `new modelClass()` probe, no per-class cache, no
   * WeakMap. Anything that isn't `"json"` falls through to the
   * standard scalar-column whereIn path.
   *
   * If a caller really does whereIn-against-a-json-object column, the
   * `@>` query still runs — it just won't match anything useful.
   * Loud-failure-at-the-DB is preferred over the previous mode where
   * the runtime probe could silently downgrade to broken `IN ($1)`
   * SQL when `new modelClass()` couldn't construct an instance.
   */
  private _isJsonArrayColumn(
    _modelClass: any,
    colName: any,
    schema?: SchemaDefinition,
  ): boolean {
    if (typeof colName !== "string") return false;
    if (!schema) return false;
    return schema[colName] === "json";
  }

  /**
   * Translate `whereIn(jsonArrayCol, vals)` into "the array contains
   * any of these values" SQL.
   *
   *   - Postgres jsonb: `(col @> ?::jsonb OR col @> ?::jsonb …)`
   *     where each binding is a single-element JSON array stringified.
   *     `@>` is the jsonb-contains operator and matches when every
   *     element on the right exists in the left (so wrapping each value
   *     in `[v]` gives us proper "any of" semantics across an OR fan-out).
   *
   *   - SQLite TEXT: `(CAST(col AS TEXT) LIKE ? OR …)` where each
   *     binding is `%"<value>"%`. The surrounding quotes are essential —
   *     they pin the match to a literal JSON-array element and stop
   *     prefix/suffix collisions between ids that happen to share a
   *     common substring.
   *
   * An empty values array yields a hard-false predicate so the result
   * matches the conventional `WHERE col IN ()` semantics ("nothing").
   *
   * Both branches go through `whereRaw` rather than `where(col, op, val)`
   * because (a) we want to OR multiple containment checks under a
   * single grouped clause, and (b) the `?::jsonb` cast in the Postgres
   * branch is awkward to express through `where(col, "@>", val)` without
   * Knex re-binding the placeholder.
   */
  private _applyJsonArrayWhereIn<T>(
    chain: QueryChain<T>,
    colName: string,
    values: any[],
  ): QueryChain<T> {
    const c: any = chain;
    if (!Array.isArray(values) || values.length === 0) {
      return c.whereRaw("1 = 0");
    }
    if (this.isSqlite) {
      const parts = values.map(() => `CAST(?? AS TEXT) LIKE ?`).join(" OR ");
      const bindings: any[] = [];
      for (const v of values) {
        bindings.push(colName, `%"${String(v)}"%`);
      }
      return c.whereRaw(`(${parts})`, bindings);
    }
    // Postgres jsonb. Wrap each value in a one-element JSON array so
    // `@>` is true iff the column's array contains that value.
    const parts = values.map(() => `?? @> ?::jsonb`).join(" OR ");
    const bindings: any[] = [];
    for (const v of values) {
      bindings.push(colName, JSON.stringify([v]));
    }
    return c.whereRaw(`(${parts})`, bindings);
  }

  queryFromClient<T>(
    modelClass: ModelConstructor<T>,
    scope: Record<string, any>,
    rawSteps: QueryStep[] | string | undefined,
  ): QueryChain<T> {
    // Normalize: socket sends an array, HTTP may send a JSON string
    let steps: QueryStep[] = [];
    if (Array.isArray(rawSteps)) {
      steps = rawSteps;
    } else if (typeof rawSteps === "string") {
      try {
        steps = JSON.parse(rawSteps);
      } catch {
        throw new ClientError("Invalid __query: malformed JSON");
      }
    }
    if (!Array.isArray(steps)) steps = [];

    const schema = (modelClass.__schema as SchemaDefinition) ?? {};
    const validColumns = new Set([
      "id",
      "createdAt",
      "updatedAt",
      ...Object.keys(schema),
    ]);

    // Start with scope — always first, never overridable.
    // Scope can be an object { org: "xxx" } or a function (qb) => qb.where(...)
    let chain: QueryChain<T>;
    if (typeof scope === "function") {
      const table = tableName(modelClass);
      let knexQuery = this.read(table);
      knexQuery = knexQuery.where(scope);
      chain = this._buildQuery(modelClass, knexQuery);
    } else {
      chain = this.query(modelClass).where(scope);
    }

    let hasLimit = false;
    let hasClearLimit = false;

    // Pre-scan for clearLimit to know whether to bypass clamping
    for (const step of steps) {
      if (step.method === "clearLimit") {
        hasClearLimit = true;
        break;
      }
    }

    for (const step of steps) {
      if (!BackendAdapter.SAFE_CLIENT_METHODS.has(step.method)) continue;

      // clearLimit — bypass default limit, cap at 10,000 as safety net
      if (step.method === "clearLimit") {
        hasLimit = true;
        chain = chain.limit(10_000);
        continue;
      }

      // search() is handled specially — not a Knex method
      if (step.method === "search") {
        const term = typeof step.args[0] === "string" ? step.args[0] : "";
        if (term.trim()) {
          chain = (chain as any).search(term);
        }
        continue;
      }

      const args = this._sanitizeStepArgs(
        step,
        validColumns,
        modelClass.type,
        schema,
      );

      // Skip empty where({}) — sanitizer returns [] to signal "no-op"
      if (args.length === 0 && step.method !== "limit") continue;

      // Handle rewritten ref subqueries: ["__rewrite:whereIn", refKey, subquery]
      if (typeof args[0] === "string" && args[0].startsWith("__rewrite:")) {
        const rewriteMethod = args[0].slice("__rewrite:".length);
        chain = (chain as any)[rewriteMethod](args[1], args[2]);
        continue;
      }

      // Sanitize limit — coerce to a positive integer, fall back to
      // DEFAULT_LIMIT on parse failure. No upper clamp; clients that
      // need an unusually large window pass it explicitly. Skipped
      // entirely when `clearLimit()` was used — that path sets the
      // 10 000 safety cap below.
      if (step.method === "limit") {
        hasLimit = true;
        if (!hasClearLimit) {
          args[0] = Math.max(
            Number.parseInt(args[0]) || BackendAdapter.DEFAULT_LIMIT,
            1,
          );
        }
      }

      // ── whereIn on a JSON-array column → "array contains any of" ─────
      // Stock `WHERE col IN (?, ?)` compares the whole jsonb value to
      // each binding as a string, which never matches when the column
      // stores an array. Detect that case and emit dialect-appropriate
      // containment SQL instead so callers can write the natural
      // `Scene.whereIn("tags", [tagId])` and have it Just Work.
      if (
        (step.method === "whereIn" || step.method === "orWhereIn") &&
        this._isJsonArrayColumn(modelClass, args[0], schema)
      ) {
        chain = this._applyJsonArrayWhereIn(
          chain,
          args[0] as string,
          args[1] as any[],
        );
        continue;
      }

      chain = (chain as any)[step.method](...args);
    }

    // Inject default limit if client didn't send one
    if (!hasLimit) {
      chain = chain.limit(BackendAdapter.DEFAULT_LIMIT);
    }

    return chain;
  }

  /**
   * Validate and transform a single step's args for safe Knex execution.
   * Handles nested builder callbacks ({ __nested: QueryStep[] }),
   * column validation, and operator whitelisting.
   */
  private _sanitizeStepArgs(
    step: QueryStep,
    validColumns: Set<string>,
    modelType: string,
    schema?: SchemaDefinition,
  ): any[] {
    const args = [...(step.args ?? [])];

    // Skip no-op where: where() with no args or where({}) with empty object
    if (BackendAdapter.COLUMN_ARG_METHODS.has(step.method)) {
      if (args.length === 0) return [];
      const firstArg = args[0];
      if (typeof firstArg === "undefined") return [];
      if (
        typeof firstArg === "object" &&
        firstArg !== null &&
        !Array.isArray(firstArg) &&
        !firstArg.__nested &&
        Object.keys(firstArg).length === 0
      )
        return [];
    }

    // Handle nested builder: .where((builder) => builder.where(...).orWhere(...))
    // Serialized as: { __nested: [{ method, args }, ...] }
    if (BackendAdapter.COLUMN_ARG_METHODS.has(step.method)) {
      const firstArg = args[0];

      if (
        typeof firstArg === "object" &&
        firstArg !== null &&
        Array.isArray(firstArg.__nested)
      ) {
        const nestedSteps: QueryStep[] = firstArg.__nested;
        // Replace with a Knex builder callback
        args[0] = (builder: any) => {
          for (const nested of nestedSteps) {
            if (!BackendAdapter.SAFE_CLIENT_METHODS.has(nested.method))
              continue;
            const innerArgs = this._sanitizeStepArgs(
              nested,
              validColumns,
              modelType,
            );
            builder = builder[nested.method](...innerArgs);
          }
        };
        return args;
      }

      if (typeof firstArg === "string") {
        // ── Dot-notation ref subquery rewriting ───────────────────
        // "test.category" → whereIn("test", subquery on tests table)
        if (firstArg.includes(".") && schema) {
          const rewritten = this._rewriteRefDotNotation(step, args, schema);
          if (rewritten) return rewritten;
          // Falls through if not a valid ref (throws below)
        }

        if (!validColumns.has(firstArg)) {
          throw new ClientError(
            `Invalid column "${firstArg}" on model "${modelType}"`,
          );
        }
        // 3-arg where: validate operator
        if (args.length === 3 && typeof args[1] === "string") {
          if (!BackendAdapter.SAFE_OPERATORS.has(args[1].toLowerCase())) {
            throw new ClientError(`Invalid operator "${args[1]}"`);
          }
        }
      } else if (
        typeof firstArg === "object" &&
        firstArg !== null &&
        !Array.isArray(firstArg)
      ) {
        // Object form: where({ col1: val, col2: val })
        for (const key of Object.keys(firstArg)) {
          if (!validColumns.has(key)) {
            throw new ClientError(
              `Invalid column "${key}" on model "${modelType}"`,
            );
          }
        }
      }
    }

    // select: validate all column names
    if (step.method === "select") {
      const cols = Array.isArray(args[0]) ? args[0] : args;
      for (const col of cols) {
        if (typeof col === "string" && col !== "*" && !validColumns.has(col)) {
          throw new ClientError(
            `Invalid column "${col}" on model "${modelType}"`,
          );
        }
      }
    }

    return args;
  }

  /**
   * Rewrite dot-notation ref columns into subqueries.
   *
   * "test.category" on a Result model (which has `test: Test` ref) becomes:
   *   whereIn("test", knex("tests").select("id").where("category", value))
   *
   * Returns rewritten args array, or null if the column isn't a valid ref.
   */
  private _rewriteRefDotNotation(
    step: QueryStep,
    args: any[],
    schema: SchemaDefinition,
  ): any[] | null {
    const dot = (args[0] as string).indexOf(".");
    const refKey = (args[0] as string).slice(0, dot);
    const refColumn = (args[0] as string).slice(dot + 1);
    if (!refKey || !refColumn) return null;

    // Ref key must exist in the current model's schema as a ref
    const colDef = schema[refKey];
    if (!colDef || typeof colDef === "string" || colDef.kind !== "ref")
      return null;

    // Resolve the target model — prefer the registry, fall back to the ref's target
    const targetType = colDef.target?.type;
    if (!targetType) return null;
    const resolvedTarget = this._models.get(targetType) ?? colDef.target;
    const targetSchema = (resolvedTarget?.__schema as SchemaDefinition) ?? null;
    const targetTable = pluralize(targetType);

    // Validate the nested column exists on the target model
    if (targetSchema) {
      const targetValidColumns = new Set([
        "id",
        "createdAt",
        "updatedAt",
        ...Object.keys(targetSchema),
      ]);
      if (!targetValidColumns.has(refColumn)) {
        throw new ClientError(
          `Invalid column "${refColumn}" on referenced model "${targetType}"`,
        );
      }
    }

    // Build the subquery: SELECT id FROM <target_table> WHERE <refColumn> ...
    const subquery = this.read(targetTable).select("id");

    const method = step.method;

    // where("test.category", value)  → whereIn("test", sub.where("category", value))
    // where("test.category", "=", v) → whereIn("test", sub.where("category", v))
    // where("test.category", "!=", v)→ whereNotIn("test", sub.where("category", v))
    // whereIn("test.cat", [...])     → whereIn("test", sub.whereIn("category", [...]))
    // whereNot("test.cat", v)        → whereNotIn("test", sub.where("category", v))
    // whereNotIn("test.cat", [...])  → whereNotIn("test", sub.whereIn("category", [...]))
    if (method === "where" || method === "andWhere" || method === "orWhere") {
      if (args.length === 3) {
        // 3-arg: where("test.cat", op, value)
        const op = String(args[1]).toLowerCase();
        if (!BackendAdapter.SAFE_OPERATORS.has(op)) {
          throw new ClientError(`Invalid operator "${args[1]}"`);
        }
        const negate = op === "!=" || op === "<>";
        return [
          negate ? "__rewrite:whereNotIn" : "__rewrite:whereIn",
          refKey,
          negate
            ? subquery.where(refColumn, args[2])
            : subquery.where(refColumn, args[1], args[2]),
        ];
      }
      // 2-arg: where("test.cat", value)
      return ["__rewrite:whereIn", refKey, subquery.where(refColumn, args[1])];
    }

    if (method === "whereIn" || method === "orWhereIn") {
      return [
        "__rewrite:whereIn",
        refKey,
        subquery.whereIn(refColumn, args[1]),
      ];
    }

    if (method === "whereNot") {
      return [
        "__rewrite:whereNotIn",
        refKey,
        subquery.where(refColumn, args[1]),
      ];
    }

    if (method === "whereNotIn") {
      return [
        "__rewrite:whereNotIn",
        refKey,
        subquery.whereIn(refColumn, args[1]),
      ];
    }

    return null;
  }

  private _buildQuery<T>(
    modelClass: ModelConstructor<T>,
    knexQuery: any,
  ): QueryChain<T> {
    const chain: any = {};

    for (const method of CHAINABLE_METHODS) {
      chain[method] = (...args: any[]) => {
        // Dot-notation ref subquery rewriting for server-side queries
        if (
          typeof args[0] === "string" &&
          args[0].includes(".") &&
          BackendAdapter.COLUMN_ARG_METHODS.has(method)
        ) {
          const schema =
            (modelClass.__schema as SchemaDefinition) ?? {};
          const rewritten = this._rewriteRefDotNotation(
            { method, args },
            args,
            schema,
          );
          if (rewritten) {
            const rewriteMethod = (rewritten[0] as string).slice(
              "__rewrite:".length,
            );
            return this._buildQuery(
              modelClass,
              knexQuery[rewriteMethod](rewritten[1], rewritten[2]),
            );
          }
        }
        // ── whereIn on a JSON-array column → containment SQL ───────────
        // Same dispatch `queryFromClient` does for client-sent queries.
        // Without this, a server-side
        //   `Post.whereIn("performers", [id]).find()`
        // falls through to bare `WHERE "performers" IN (?)` and Postgres
        // errors with `invalid input syntax for type json` on the JSONB
        // column.
        if (
          (method === "whereIn" || method === "orWhereIn") &&
          typeof args[0] === "string"
        ) {
          const schema =
            (modelClass.__schema as SchemaDefinition) ?? {};
          if (this._isJsonArrayColumn(modelClass, args[0], schema)) {
            return this._buildQuery(
              modelClass,
              this._applyJsonArrayWhereIn(
                knexQuery,
                args[0] as string,
                args[1] as any[],
              ),
            );
          }
        }
        return this._buildQuery(modelClass, knexQuery[method](...args));
      };
    }

    // search() — applies hybrid full-text + fuzzy search SQL
    chain.search = (term: string) => {
      const searchFields = modelClass.searchFields as
        | string[]
        | undefined;
      if (!searchFields?.length || !term.trim()) {
        return this._buildQuery(modelClass, knexQuery);
      }
      const modified = this._applySearch(knexQuery, term, modelClass);
      return this._buildQuery(modelClass, modified);
    };

    chain.find = async (): Promise<T[]> => {
      const rows = await knexQuery;
      return Array.isArray(rows)
        ? rows.map((row: any) => hydrate(modelClass, this, row))
        : [];
    };

    chain.first = async (): Promise<T | null> => {
      const row = await knexQuery.first();
      return row ? hydrate(modelClass, this, row) : null;
    };

    chain.count = async (column?: string): Promise<number> => {
      const clone = knexQuery.clone();
      const result = await clone
        .clearSelect()
        .clearOrder()
        .count(column || "*");
      return Number.parseInt(`${Object.values(result[0] || {})[0] || "0"}`, 10);
    };

    chain.exec = () => knexQuery;
    chain.clone = () => this._buildQuery(modelClass, knexQuery.clone());

    // Internal metadata — used by subscription manager for type indexing
    chain.__modelType = modelClass.type;
    chain.__modelClass = modelClass;
    chain.__adapter = this;

    return chain as QueryChain<T>;
  }

  // ── patch (atomic JSONB SQL) ─────────────────────────────────────────

  async patch(model: any, ops: PatchOp[]): Promise<void> {
    if (!ops.length) return;

    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);
    const schema = (ModelClass.__schema as SchemaDefinition) ?? {};

    // ── SQLite: read-modify-write (no native JSONB operators) ──────
    if (this.isSqlite) {
      await this._patchSqlite(model, ops, table, schema);
      return;
    }

    const cleanups: Array<() => Promise<void> | void> = [];

    try {
      await this._patchPostgres(model, ops, table, schema, cleanups);
    } catch (err) {
      await this._runCleanups(cleanups, `${ModelClass.type}:patch`);
      throw err;
    }

    this._notifyChange(model);
  }

  private async _patchPostgres(
    model: any,
    ops: PatchOp[],
    table: string,
    schema: SchemaDefinition,
    cleanups: Array<() => Promise<void> | void>,
  ): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    await this.runHooks(model, "patch", "before", {
      data: { ops },
      cleanups,
    });

    type ParsedOp = {
      op: PatchOp;
      column: string;
      colType: string;
      innerSegments: string[];
    };

    const parsed: ParsedOp[] = [];
    const VALID_COLUMN_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

    for (const o of ops) {
      const segments = o.path.slice(1).split("/");
      const column = segments[0]!;
      const innerSegments = segments.slice(1);

      if (!VALID_COLUMN_RE.test(column)) {
        throw new ClientError(`patch: invalid column name "${column}"`);
      }
      if (!(column in schema)) {
        throw new ClientError(
          `patch: unknown column "${column}" on model "${ModelClass.type}"`,
        );
      }

      const colType = resolveColType(schema[column]!);

      if (colType !== "json" && innerSegments.length > 0) {
        throw new ClientError(
          `patch: column "${column}" is ${colType}, not json — path must be "/${column}" (got "${o.path}")`,
        );
      }

      if (o.op === "test") {
        const current =
          colType === "json"
            ? model.__data[column] || {}
            : model.__data[column];
        const actual = innerSegments.length
          ? current?.[innerSegments[0]!]
          : current;
        // TypeScript narrows `o` to TestOperation<any> via the
        // discriminant check above; `.value` is typed.
        if (!equal(actual, o.value)) {
          throw new ClientError(`patch test failed at ${o.path}`);
        }
      }
      parsed.push({ op: o, column, colType, innerSegments });
    }

    // Group by column
    const byColumn = new Map<string, ParsedOp[]>();
    for (const p of parsed) {
      if (!byColumn.has(p.column)) byColumn.set(p.column, []);
      byColumn.get(p.column)!.push(p);
    }

    // Build SQL per column
    const updateFields: Record<string, any> = { updatedAt: new Date() };

    for (const [column, columnOps] of byColumn) {
      const colType = columnOps[0]!.colType;

      // Scalar columns: direct value SET. Only `add` / `replace` /
      // `remove` are meaningful at the root of a scalar column; the
      // other discriminants either need a json path (`move`, `copy`)
      // or were short-circuited above (`test`).
      if (colType !== "json") {
        const lastOp = columnOps[columnOps.length - 1]!;
        const op = lastOp.op;
        if (op.op === "test") continue;
        // `value` is present on AddOperation / ReplaceOperation; a
        // bare `remove` leaves the field undefined → coerce to null.
        const value =
          op.op === "add" || op.op === "replace" ? op.value : undefined;
        updateFields[column] =
          colType === "datetime"
            ? value
              ? new Date(value)
              : null
            : (value ?? null);
        continue;
      }

      // JSON columns: atomic JSONB SQL
      let sql = `COALESCE(${column}, '{}'::jsonb)`;
      const bindings: any[] = [];
      const ensured = new Set<string>();

      // Pre-batch in-memory state for the column. The optimistic
      // local apply in `Model.patch` already ran before this adapter
      // call, so `__data[column]` reflects POST-batch state.
      // `__serverSnapshot[column]` is the last server-authoritative
      // value, which corresponds to the row's state BEFORE this
      // batch's ops applied — exactly what we need to decide whether
      // an intermediate path needs to be ensured.
      //
      // When the snapshot isn't available (rare — only on a freshly
      // constructed model that hasn't been hydrated), fall back to
      // empty so every depth gets an ensure (safe but adds a tiny
      // overhead).
      const preState: any =
        (model as any).__serverSnapshot?.[column] ?? null;
      // Tracks paths whose subtree was removed earlier in THIS batch.
      // Subsequent ensures targeting these paths must still emit so
      // the leaf set has a parent to land on. The "" sentinel marks
      // a root-wipe (`remove /` or root replace) — every subsequent
      // path needs an ensure regardless of pre-state.
      const removedPaths = new Set<string>();

      const ancestorOrSelfRemoved = (segments: string[]): boolean => {
        if (removedPaths.has("")) return true;
        for (let d = 1; d <= segments.length; d++) {
          if (removedPaths.has(segments.slice(0, d).join(","))) return true;
        }
        return false;
      };

      for (const { op: o, innerSegments } of columnOps) {
        switch (o.op) {
          case "add": {
            if (innerSegments[innerSegments.length - 1] === "-") {
              const parent = innerSegments.slice(0, -1);
              // Array-append (`/-`) — ensure the parent path exists
              // as `[]` if missing. The append target is an array,
              // so we override the segment-derived default with the
              // hardcoded `'[]'::jsonb` (matching the pre-DOL-675
              // behaviour). The pre-state-aware ensure skips
              // intermediates that already exist on the row and
              // weren't removed earlier in this batch, preserving
              // any prior mutations (DOL-675).
              this._ensureIntermediates(
                parent,
                column,
                ensured,
                preState,
                ancestorOrSelfRemoved,
                (pgPath /* defaultJson ignored — append target is an array */) => {
                  sql = `jsonb_set_lax(${sql}, ?::text[], '[]'::jsonb, true, 'use_json_null')`;
                  bindings.push(pgPath);
                },
              );
              sql = `jsonb_insert(${sql}, ?::text[], ?::jsonb, true)`;
              bindings.push(
                `{${[...parent, "-1"].join(",")}}`,
                JSON.stringify(o.value),
              );
            } else if (innerSegments.length === 0) {
              sql = "?::jsonb";
              bindings.push(JSON.stringify(o.value));
              // Root replace — every future path starts from this
              // new value. Treat it like a root-wipe for ensure
              // tracking; pre-state is irrelevant.
              removedPaths.clear();
              removedPaths.add("");
            } else {
              this._ensureIntermediates(
                innerSegments,
                column,
                ensured,
                preState,
                ancestorOrSelfRemoved,
                (pgPath, defaultJson) => {
                  sql = `jsonb_set_lax(${sql}, ?::text[], ${defaultJson}, true, 'use_json_null')`;
                  bindings.push(pgPath);
                },
              );
              sql = `jsonb_set_lax(${sql}, ?::text[], ?::jsonb, true, 'use_json_null')`;
              bindings.push(
                `{${innerSegments.join(",")}}`,
                JSON.stringify(o.value),
              );
            }
            break;
          }
          case "replace": {
            // `case "replace"` narrows `o` to ReplaceOperation<any>.
            if (innerSegments.length === 0) {
              sql = "?::jsonb";
              bindings.push(JSON.stringify(o.value));
              // Root replace — every future path starts from this
              // new value. Treat it like a root-wipe for ensure
              // tracking; pre-state is irrelevant.
              removedPaths.clear();
              removedPaths.add("");
            } else {
              this._ensureIntermediates(
                innerSegments,
                column,
                ensured,
                preState,
                ancestorOrSelfRemoved,
                (pgPath, defaultJson) => {
                  sql = `jsonb_set_lax(${sql}, ?::text[], ${defaultJson}, true, 'use_json_null')`;
                  bindings.push(pgPath);
                },
              );
              sql = `jsonb_set_lax(${sql}, ?::text[], ?::jsonb, true, 'use_json_null')`;
              bindings.push(
                `{${innerSegments.join(",")}}`,
                JSON.stringify(o.value),
              );
            }
            break;
          }
          case "remove": {
            if (innerSegments.length === 0) {
              sql = `'{}'::jsonb`;
              removedPaths.clear();
              removedPaths.add("");
            } else {
              sql = `(${sql} #- ?::text[])`;
              bindings.push(`{${innerSegments.join(",")}}`);
              removedPaths.add(innerSegments.join(","));
            }
            break;
          }
          case "test":
            break;
          default:
            throw new ClientError(`patch: unsupported op "${o.op}"`);
        }
      }

      updateFields[column] = this.write.raw(sql, bindings);
    }

    // Heal legacy `data` overflow: strip any schema-known keys we just
    // wrote so a future read can't resurrect a stale snapshot from the
    // JSON blob. Pre-fix this was the silent "save reverts" failure
    // mode for rows imported when the schema had fewer columns —
    // `serialize()` writes the column AND a `data` overflow copy until
    // every key is promoted, but `patch()` only updates the column,
    // leaving the JSON copy to win on the next read (see the
    // `hydrate()` overflow filter for the symmetric guard).
    const staleKeys = [...byColumn.keys()].filter(
      (k) => k !== "data" && k in schema,
    );
    if (staleKeys.length > 0) {
      // `data` jsonb column always exists; COALESCE handles the rare
      // row where it's null. `- text[]` removes the listed top-level
      // keys (PostgreSQL ≥ 10).
      updateFields.data = this.write.raw(
        `COALESCE(data, '{}'::jsonb) - ?::text[]`,
        [`{${staleKeys.join(",")}}`],
      );
    }

    await this.write(table).where("id", model.id).update(updateFields);
    await this.runHooks(model, "patch", "after", {
      data: { ops },
      cleanups,
    });
  }

  /**
   * Walk every parent depth of a JSON path and emit a `jsonb_set_lax`
   * call to ensure that intermediate exists ONLY when needed:
   *
   *   1. If the path already exists in the row's pre-batch snapshot
   *      (`preState`) AND no earlier op in the same batch removed
   *      that path or one of its ancestors (`ancestorOrSelfRemoved`),
   *      skip the ensure entirely. The intermediate is intact in the
   *      live SQL expression, and emitting an ensure would silently
   *      undo prior `remove` ops by re-reading from the original
   *      column value (DOL-675).
   *
   *   2. Otherwise the ensure emits a `jsonb_set_lax` with a STATIC
   *      `'{}'::jsonb` (or `'[]'::jsonb`) default. Reading from the
   *      original column inside the ensure would also undo prior
   *      mutations whenever the read path overlaps with an earlier
   *      remove — so even when an ensure IS needed, the static
   *      default is the safe choice. Any data that was at the path
   *      pre-batch was either preserved upstream (case 1) or wiped
   *      by an earlier remove in this batch (case 2, expected).
   *
   * The shape created when the intermediate is missing depends on
   * the NEXT path segment: a numeric index (`"0"`, `"12"`) or the
   * append marker (`"-"`) means the intermediate is an array
   * (`'[]'::jsonb`); any other key means it's a plain object
   * (`'{}'::jsonb`).
   *
   * Without the array branch, a patch like
   * `replace /blocks/<id>/shots/0/panel` on a row with no prior
   * `shots` field would write `shots = { "0": { panel: … } }`,
   * passing the JSON write but blowing up every subsequent
   * `for (const s of block.shots)` with "object is not iterable"
   * once the row hydrates back into JS.
   */
  private _ensureIntermediates(
    segments: string[],
    column: string,
    ensured: Set<string>,
    preState: any,
    ancestorOrSelfRemoved: (segments: string[]) => boolean,
    emit: (pgPath: string, defaultJson: string) => void,
  ): void {
    for (let depth = 1; depth < segments.length; depth++) {
      const path = segments.slice(0, depth);
      const pathKey = path.join(",");
      if (
        BackendAdapter._pathExistsInData(preState, path) &&
        !ancestorOrSelfRemoved(path)
      ) {
        // Path already lives on the row and isn't under a
        // previously-removed ancestor — the live SQL expression
        // still has it intact. Emitting an ensure would re-read the
        // original column at this path and overwrite any earlier
        // remove ops in this batch (DOL-675).
        continue;
      }
      const key = `${column}:${pathKey}`;
      if (!ensured.has(key)) {
        ensured.add(key);
        const defaultJson = isArrayIndexSegment(segments[depth])
          ? "'[]'::jsonb"
          : "'{}'::jsonb";
        emit(`{${pathKey}}`, defaultJson);
      }
    }
  }

  /**
   * Walk a record-shaped JSONB value to determine whether `segments`
   * names a present (non-null) path. Used by `_ensureIntermediates`
   * to skip emits for paths that already exist in the pre-batch row
   * state.
   */
  private static _pathExistsInData(data: any, segments: string[]): boolean {
    if (data == null) return false;
    let cursor = data;
    for (const seg of segments) {
      if (cursor == null || typeof cursor !== "object") return false;
      cursor = cursor[seg];
    }
    return cursor != null;
  }

  /**
   * SQLite patch fallback: read-modify-write.
   * Reads the current row, applies RFC 6902 ops per-column in JS,
   * then writes back. Safe for SQLite's single-writer model.
   */
  private async _patchSqlite(
    model: any,
    ops: PatchOp[],
    table: string,
    schema: SchemaDefinition,
  ): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    const cleanups: Array<() => Promise<void> | void> = [];

    try {
      await this.runHooks(model, "patch", "before", {
        data: { ops },
        cleanups,
      });
      await this._patchSqliteBody(model, ops, table, schema);
      await this.runHooks(model, "patch", "after", {
        data: { ops },
        cleanups,
      });
    } catch (err) {
      await this._runCleanups(cleanups, `${ModelClass.type}:patch`);
      throw err;
    }

    this._notifyChange(model);
  }

  private async _patchSqliteBody(
    model: any,
    ops: PatchOp[],
    table: string,
    schema: SchemaDefinition,
  ): Promise<void> {
    // Read current row
    const row = await this.write(table).where("id", model.id).first();
    if (!row) throw new ClientError(`patch: row not found id=${model.id}`);

    const updateFields: Record<string, any> = { updatedAt: new Date() };

    // Group ops by top-level column
    const byColumn = new Map<string, PatchOp[]>();
    for (const op of ops) {
      const column = op.path.slice(1).split("/")[0]!;
      if (!byColumn.has(column)) byColumn.set(column, []);
      byColumn.get(column)!.push(op);
    }

    for (const [column, columnOps] of byColumn) {
      if (!(column in schema)) {
        throw new ClientError(
          `patch: unknown column "${column}" on model "${(model.constructor as typeof Model).type}"`,
        );
      }

      const colType = resolveColType(schema[column]!);

      // Scalar columns: just take the last replace/add value
      if (colType !== "json") {
        const lastOp = columnOps[columnOps.length - 1]!;
        if (lastOp.op === "test") continue;
        const value =
          lastOp.op === "add" || lastOp.op === "replace"
            ? lastOp.value
            : undefined;
        updateFields[column] =
          colType === "datetime"
            ? value
              ? new Date(value)
              : null
            : (value ?? null);
        continue;
      }

      // JSON columns: apply RFC 6902 patch in JS
      let current = row[column];
      if (typeof current === "string") {
        try {
          current = JSON.parse(current);
        } catch {
          current = {};
        }
      }
      if (current == null) current = {};

      // Wrap column ops as a proper JSON Patch document (paths relative to column root)
      const subOps: PatchOp[] = columnOps.map((op) => ({
        ...op,
        path: op.path.slice(1 + column.length), // strip /<column> prefix
      }));

      const result = applyPatch(current, subOps, true, false);
      updateFields[column] = JSON.stringify(result.newDocument);
    }

    // Heal legacy `data` overflow — mirror of the Postgres branch.
    // See `_patchPostgres` for the full rationale; in short, rows
    // imported when a column was still part of the JSON overflow blob
    // can resurrect stale snapshots on the next read, so we strip the
    // touched schema keys from the blob whenever we patch them.
    const staleKeys = [...byColumn.keys()].filter(
      (k) => k !== "data" && k in schema,
    );
    if (staleKeys.length > 0) {
      let dataBlob: Record<string, any> = {};
      const existing = row.data;
      if (typeof existing === "string") {
        try {
          dataBlob = JSON.parse(existing) ?? {};
        } catch {
          dataBlob = {};
        }
      } else if (existing && typeof existing === "object") {
        dataBlob = { ...(existing as Record<string, any>) };
      }
      let touched = false;
      for (const key of staleKeys) {
        if (key in dataBlob) {
          delete dataBlob[key];
          touched = true;
        }
      }
      if (touched) {
        updateFields.data = JSON.stringify(dataBlob);
      }
    }

    await this.write(table).where("id", model.id).update(updateFields);
  }

  // ── Increment/Decrement ──────────────────────────────────────────────

  async increment(model: any, field: string, amount = 1): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);
    await this.write(table).where("id", model.id).increment(field, amount);
    const row = await this.write(table)
      .where("id", model.id)
      .select(field)
      .first();
    if (row) (model as any)[field] = row[field];
  }

  async decrement(model: any, field: string, amount = 1): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);
    await this.write(table).where("id", model.id).decrement(field, amount);
    const row = await this.write(table)
      .where("id", model.id)
      .select(field)
      .first();
    if (row) (model as any)[field] = row[field];
  }

  /**
   * Atomic bulk-increment over a set of row ids in one SQL statement.
   *
   *   UPDATE <table> SET <field> = <field> + <amount> WHERE id IN (...)
   *
   * The single-row `increment()` path above is read-modify-write at the
   * Knex layer too (Knex's `.increment()` builds a `SET col = col + ?`
   * UPDATE — atomic per-row), but issuing one SQL per id is slow for the
   * hot counter paths in `hooks/scene-performers.ts` and
   * `hooks/tag-counts.ts` (which fan out to N performers / M tags per
   * Scene save). This method ships a single UPDATE.
   *
   * Use when the calling code doesn't care about post-update field
   * values being reflected on the model instances — the standard case
   * for hooks, which fire-and-forget.
   *
   * `amount` can be negative for atomic bulk decrement.
   */
  async incrementMany(
    modelClass: ModelConstructor,
    ids: readonly string[],
    field: string,
    amount: number,
  ): Promise<void> {
    if (amount === 0 || ids.length === 0) return;
    const table = tableName(modelClass);
    await this.write(table).whereIn("id", ids).increment(field, amount);
  }

  /**
   * Run `fn` inside a Knex transaction. Returns whatever `fn` returns,
   * or rolls back on any thrown error.
   *
   * Caveat: parcae model operations issued inside `fn` do NOT
   * automatically participate in the transaction — they go through the
   * adapter's default knex handle, which is the outer connection.
   * Callers that need a fully-transactional model operation should
   * still drop down to raw SQL via the `trx` argument until parcae
   * grows transaction-threading at the model layer.
   *
   * The primary use case today is grouping a few raw `UPDATE`/`DELETE`
   * statements (e.g. delete-scene's joint-table cleanup) so a crash
   * mid-way doesn't leave half the rows scrubbed.
   */
  async runInTransaction<T>(
    fn: (trx: any) => Promise<T>,
  ): Promise<T> {
    return this.write.transaction(async (trx: any) => fn(trx));
  }

  /** Raw access to the write Knex handle. Use sparingly — prefer model
   *  query chains. Provided for the few places that need a raw UPDATE
   *  (counter bumps, bulk deletes) and for transaction integration. */
  knex(): any {
    return this.write;
  }

  // ── Hooks ────────────────────────────────────────────────────────────

  async runHooks(
    model: any,
    action: string,
    timing: string,
    extra?: {
      data?: Record<string, any>;
      user?: { id: string; [key: string]: any } | null;
      cleanups?: Array<() => Promise<void> | void>;
    },
  ): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    const hooks = getHooksFor(
      ModelClass.type,
      timing as HookTiming,
      action as HookAction,
    );

    // Resolve user: explicit extra > AsyncLocalStorage request context
    const user = extra?.user ?? getRequestUser() ?? undefined;

    for (const hookEntry of hooks) {
      const isAsync = hookEntry.async;

      const onError = (fn: () => Promise<void> | void) => {
        if (isAsync) {
          log.warn(
            `[hook] ctx.onError() called inside async hook for ${hookEntry.modelType}:${action} — ignored (async hooks run outside the caller's error path)`,
          );
          return;
        }
        if (!extra?.cleanups) {
          log.warn(
            `[hook] ctx.onError() called outside a tracked operation for ${hookEntry.modelType}:${action} — ignored`,
          );
          return;
        }
        extra.cleanups.push(fn);
      };

      const ctx = {
        model,
        action: action as HookAction,
        data: extra?.data,
        user,
        lock: globalLock,
        enqueue: globalEnqueue,
        onError,
      };

      if (isAsync) {
        Promise.resolve(hookEntry.handler(ctx)).catch((err) => {
          log.error(
            `[hook] Async error in ${hookEntry.modelType}:${action}:`,
            err,
          );
        });
      } else {
        await hookEntry.handler(ctx as any);
      }
    }
  }

  /**
   * Run compensating actions registered via `ctx.onError` in LIFO order.
   * Called after a transaction rollback when an operation has failed.
   * Cleanup errors are logged but never replace the caller's original error.
   */
  private async _runCleanups(
    cleanups: Array<() => Promise<void> | void>,
    label: string,
  ): Promise<void> {
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try {
        await cleanups[i]!();
      } catch (cleanupErr) {
        log.error(`[parcae/onError] cleanup failed for ${label}:`, cleanupErr);
      }
    }
  }

  // ── Schema Management ────────────────────────────────────────────────

  async ensureTable(
    modelClass: ModelConstructor,
    opts: { knex?: any } = {},
  ): Promise<void> {
    if (modelClass.managed === false) {
      log.info(
        `skipping schema — model=${modelClass.type} (externally managed)`,
      );
      return;
    }

    // When a migration calls ensureModel, it passes its transactional handle
    // here so DDL runs inside the migration's transaction (matters on SQLite
    // where pool=1 would deadlock against the adapter's outer connection,
    // and on Postgres where it gives proper rollback semantics).
    const kx = opts.knex ?? this.write;

    const table = tableName(modelClass);
    const schema = (modelClass.__schema as SchemaDefinition) ?? {};
    const indexes = modelClass.indexes ?? [];

    log.info(`ensuring schema — model=${modelClass.type}`);

    const hasTable = await kx.schema.hasTable(table);

    const existingColumns: string[] = [];
    if (hasTable) {
      for (const key of Object.keys(schema)) {
        if (await kx.schema.hasColumn(table, key))
          existingColumns.push(key);
      }
      for (const sys of ["createdAt", "updatedAt", "tmp"]) {
        if (await kx.schema.hasColumn(table, sys))
          existingColumns.push(sys);
      }
    }

    let existingIndexes: string[] = [];
    try {
      if (this.isSqlite) {
        const rows = await kx.raw(
          "SELECT name FROM pragma_index_list(?)",
          [table],
        );
        existingIndexes = (rows ?? []).map((r: any) => r.name);
      } else {
        const result = await kx.raw(
          "SELECT * FROM pg_indexes WHERE tablename = ?",
          [table],
        );
        existingIndexes = result.rows.map((r: any) => r.indexname);
      }
    } catch {}

    await kx.schema[hasTable ? "alterTable" : "createTable"](
      table,
      (t: any) => {
        if (!hasTable) {
          t.string("id").primary().unique();
          this.isSqlite ? t.text("data") : t.jsonb("data");
          t.datetime("createdAt");
          t.datetime("updatedAt");
          t.string("tmp", 2048).nullable();
        }

        const originalIndex = t.index.bind(t);
        t.index = (cols: any, name: string, ...args: any[]) => {
          const prefixed = `${table}_${name || (Array.isArray(cols) ? cols.join("_") : cols)}`;
          if (!existingIndexes.includes(prefixed))
            originalIndex(cols, prefixed, ...args);
        };

        t.index("createdAt", "createdAt");
        t.index("updatedAt", "updatedAt");

        // Add tmp column for optimistic update reconciliation
        // Only add when altering an existing table — new tables already have
        // tmp created above in the !hasTable block.
        if (hasTable && !existingColumns.includes("tmp")) {
          t.string("tmp", 2048).nullable();
        }

        for (const [key, colDef] of Object.entries(schema)) {
          if (existingColumns.includes(key)) continue;
          if (["createdAt", "updatedAt", "data", "id", "tmp"].includes(key))
            continue;

          const resolved = resolveColType(colDef);
          switch (resolved) {
            case "json":
              this.isSqlite ? t.text(key) : t.jsonb(key);
              break;
            case "string":
              t.string(key, 2048);
              break;
            case "text":
              t.text(key);
              break;
            case "integer":
              t.integer(key);
              break;
            case "number":
              t.double(key);
              break;
            case "boolean":
              t.boolean(key);
              break;
            case "datetime":
              t.datetime(key);
              break;
            default:
              t.string(key, 2048);
              break;
          }
        }

        for (const idx of indexes) {
          if (Array.isArray(idx)) t.index(idx, idx.join("_"));
          else t.index(idx, idx);
        }
      },
    );

    log.info(`ensured schema — model=${modelClass.type}`);

    // ── Search schema (tsvector + trigram + optional vector) ──────────
    const searchFields = modelClass.searchFields as
      | string[]
      | undefined;
    if (searchFields?.length) {
      await this._ensureSearchSchema(table, searchFields, kx);
    }
  }

  /**
   * Create search-related columns and indexes for a table.
   * Called from ensureTable() when the model has `static searchFields`.
   */
  private async _ensureSearchSchema(
    table: string,
    fields: string[],
    kx: any = this.write,
  ): Promise<void> {
    // SQLite: no tsvector/trigram/GIN. Search uses LIKE at query time.
    if (this.isSqlite) {
      log.info(
        `search: sqlite mode — using LIKE fallback — table=${table} fields=[${fields.join(", ")}]`,
      );
      return;
    }

    await this._ensureSearchExtensions();

    // Weights by field order: A (highest), B, C, D
    const weights = ["A", "B", "C", "D"];
    const tsvectorParts = fields
      .map((field, i) => {
        const weight = weights[Math.min(i, weights.length - 1)];
        return `setweight(to_tsvector('english', coalesce(${field}, '')), '${weight}')`;
      })
      .join(" || ");

    // 1. Generated tsvector column + GIN index
    const hasSearch = await kx.schema.hasColumn(table, "_search");
    if (!hasSearch) {
      await kx.raw(
        `
        ALTER TABLE ?? ADD COLUMN _search tsvector
        GENERATED ALWAYS AS (${tsvectorParts}) STORED
      `,
        [table],
      );
      log.info(`search: added _search tsvector column — table=${table}`);
    }

    // GIN index on _search
    const searchIdxName = `${table}__search_gin`;
    try {
      await kx.raw(
        `
        CREATE INDEX IF NOT EXISTS ?? ON ?? USING gin(_search)
      `,
        [searchIdxName, table],
      );
    } catch {}

    // 2. Per-field trigram GIN indexes
    for (const field of fields) {
      const trgmIdxName = `${table}_${field}_trgm`;
      try {
        await kx.raw(
          `
          CREATE INDEX IF NOT EXISTS ?? ON ?? USING gin(?? gin_trgm_ops)
        `,
          [trgmIdxName, table, field],
        );
      } catch {}
    }

    // 3. AlloyDB: vector embedding column + ScaNN index
    if (this.engine === "alloydb") {
      const hasEmbedding = await kx.schema.hasColumn(
        table,
        "_embedding",
      );
      if (!hasEmbedding) {
        await kx.raw(
          "ALTER TABLE ?? ADD COLUMN _embedding vector(768)",
          [table],
        );
        log.info(
          `search: added _embedding vector(768) column — table=${table}`,
        );
      }

      const embIdxName = `${table}__embedding_scann`;
      try {
        await kx.raw(
          `
          CREATE INDEX IF NOT EXISTS ?? ON ?? USING scann (_embedding cosine)
          WITH (num_leaves = 1000, quantizer = 'SQ8')
        `,
          [embIdxName, table],
        );
      } catch {}
    }

    if (this.engine === "alloydb") {
      this._embeddingReady.add(table);
    }

    log.info(
      `search: indexes ensured — table=${table} fields=[${fields.join(", ")}] engine=${this.engine}`,
    );
  }

  async ensureAllTables(models: ModelConstructor[]): Promise<void> {
    for (const modelClass of models) {
      await this.ensureTable(modelClass);
    }

    // Register embedding hooks for AlloyDB models with searchFields
    if (this.engine === "alloydb") {
      this._registerEmbeddingHooks(models);
    }
  }

  /**
   * On AlloyDB, register afterSave hooks that generate embeddings for
   * models with `static searchFields`. Uses AlloyDB's native
   * `google_ml_integration` extension to call Vertex AI from SQL.
   */
  private _registerEmbeddingHooks(models: ModelConstructor[]): void {
    for (const modelClass of models) {
      const searchFields = modelClass.searchFields as
        | string[]
        | undefined;
      if (!searchFields?.length) continue;
      if (modelClass.managed === false) continue;

      const table = tableName(modelClass);

      const generateEmbedding = async (ctx: any) => {
        try {
          const model = ctx.model;
          const text = searchFields
            .map((f: string) => (model as any)[f] || "")
            .join(" ")
            .trim();
          if (!text) return;

          await this.write.raw(
            `UPDATE ?? SET _embedding = embedding('gemini-embedding-001', ?)::vector WHERE id = ?`,
            [table, text, model.id],
          );
        } catch (err: any) {
          log.warn(
            `search: embedding generation failed — model=${modelClass.type} id=${ctx.model?.id}: ${err.message}`,
          );
        }
      };

      // Register for both save (updates) and create (new records).
      // BackendAdapter.save() fires one or the other, never both.
      hook.after(modelClass, "save", generateEmbedding, {
        async: true,
        priority: 999,
      });
      hook.after(modelClass, "create", generateEmbedding, {
        async: true,
        priority: 999,
      });

      log.info(`search: registered embedding hook — model=${modelClass.type}`);
    }
  }
}
