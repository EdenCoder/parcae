import { log } from "../logger";

/**
 * BackendAdapter — Knex + Postgres persistence for Parcae Model.
 *
 * Extracted from Dollhouse Studio's adapters/model.ts (829 lines).
 * Adapted to use RTTIST-resolved schemas instead of static columns,
 * and Parcae's hook/pubsub systems.
 */

import {
  CHAINABLE_METHODS,
  type ChangeSet,
  type ColumnType,
  type ModelAdapter,
  type ModelConstructor,
  type QueryChain,
  type QueryStep,
  type SchemaDefinition,
} from "@parcae/model";
import { generateId, type Model } from "@parcae/model";
import equal from "deep-equal";
import { applyPatch, type Operation as PatchOp } from "fast-json-patch";
import pluralize from "pluralize";
import { ClientError } from "../helpers";
import type { HookAction, HookTiming } from "../routing/hook";
import { getHooksFor, hook } from "../routing/hook";
import {
  enqueue as globalEnqueue,
  lock as globalLock,
} from "../services/context";

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
 * Hydrate a DB row into a Model instance.
 * Unpacks the `data` JSONB overflow column into top-level fields.
 */
function hydrate<T>(
  modelClass: ModelConstructor<T>,
  adapter: BackendAdapter,
  row: Record<string, any>,
): T {
  const data = { ...row };

  // Unpack JSONB overflow column
  if (typeof data.data === "string") {
    try {
      Object.assign(data, JSON.parse(data.data) || {});
    } catch {}
  } else if (typeof data.data === "object" && data.data !== null) {
    Object.assign(data, data.data);
  }
  delete data.data;

  // Parse datetime strings
  const schema = (modelClass as any).__schema as SchemaDefinition | undefined;
  if (schema) {
    for (const [key, colDef] of Object.entries(schema)) {
      if (resolveColType(colDef) === "datetime" && data[key]) {
        data[key] = new Date(data[key]);
      }
    }
  }

  // Ensure timestamps
  data.createdAt = data.createdAt ? new Date(data.createdAt) : new Date();
  data.updatedAt = data.updatedAt ? new Date(data.updatedAt) : new Date();

  const instance = new modelClass(adapter, data);
  (instance as any).__isNew = false;
  return instance;
}

/**
 * Serialize model data for DB insert/update.
 * Splits into declared columns + overflow `data` JSONB blob.
 */
function serialize(model: any): Record<string, any> {
  const ModelClass = model.constructor as typeof Model;
  const schema =
    ((ModelClass as any).__schema as SchemaDefinition | undefined) ?? {};
  const raw = model.__data;

  if (!model.id) {
    (model as any).id = generateId();
  }

  const row: Record<string, any> = {
    id: model.id,
    createdAt: raw.createdAt || new Date(),
    updatedAt: new Date(),
  };

  const overflow: Record<string, any> = {};
  const systemKeys = new Set(["id", "createdAt", "updatedAt", "type"]);

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

  // ── Engine Detection ────────────────────────────────────────────────

  /**
   * Detect database engine: SQLite, AlloyDB, or standard Postgres.
   * Should be called once at startup, before ensureAllTables().
   * Pass hint="sqlite" when the Knex client is better-sqlite3.
   */
  async detectEngine(
    hint?: "sqlite",
  ): Promise<"alloydb" | "postgres" | "sqlite"> {
    if (hint === "sqlite") {
      this.engine = "sqlite";
      log.info("Database engine detected: sqlite");
      return this.engine;
    }

    try {
      const { rows } = await this.write.raw(`
        SELECT EXISTS (
          SELECT 1 FROM pg_available_extensions WHERE name = 'alloydb_scann'
        ) AS has_scann
      `);
      this.engine = rows[0]?.has_scann ? "alloydb" : "postgres";
    } catch {
      this.engine = "postgres";
    }
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
    this.subscriptions?.onModelChange(ModelClass.type);
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
    const searchFields = (modelClass as any).searchFields as string[];
    if (!searchFields?.length || !term.trim()) return knexQuery;

    const table = tableName(modelClass);

    // ── SQLite: LIKE-based fallback ─────────────────────────────────
    if (this.isSqlite) {
      const likeTerm = `%${term}%`;
      const whereParts = searchFields.map((f) => `${table}.${f} LIKE ?`);
      const whereBindings = searchFields.map(() => likeTerm);
      return knexQuery.whereRaw(
        `(${whereParts.join(" OR ")})`,
        whereBindings,
      );
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

  async save(model: any, changes: ChangeSet): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);
    const creating = changes.creating;

    if (!creating && changes.ops.length > 0) {
      const allOps: PatchOp[] = [...changes.ops];
      for (const key of changes.updates) {
        allOps.push({
          op: "replace" as const,
          path: `/${key}`,
          value: model.__data[key],
        });
      }
      await this.patch(model, allOps);
      return;
    }

    await this.runHooks(model, creating ? "create" : "save", "before");

    (model as any).updatedAt = new Date();
    if (creating && !(model as any).createdAt) {
      (model as any).createdAt = new Date();
    }

    const row = serialize(model);
    await this.write(table).insert(row).onConflict("id").merge();

    log.info(`model saved model=${ModelClass.type}, id=${model.id}`);

    await this.runHooks(model, creating ? "create" : "save", "after");
    this._notifyChange(model);
  }

  // ── remove ───────────────────────────────────────────────────────────

  async remove(model: any): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);

    await this.runHooks(model, "remove", "before");
    await this.write(table).where("id", model.id).del();
    await this.runHooks(model, "remove", "after");

    this.pubsub?.emit?.(`delete+${ModelClass.type}:${model.id}`, model.__data);
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
   *  4. Limit is clamped to a maximum value.
   *  5. A default limit is injected if the client omits one.
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
    "in",
    "not in",
    "is",
    "is not",
  ]);

  private static MAX_LIMIT = 100;
  private static DEFAULT_LIMIT = 25;

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

    const schema = ((modelClass as any).__schema as SchemaDefinition) ?? {};
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

    for (const step of steps) {
      if (!BackendAdapter.SAFE_CLIENT_METHODS.has(step.method)) continue;

      // search() is handled specially — not a Knex method
      if (step.method === "search") {
        const term = typeof step.args[0] === "string" ? step.args[0] : "";
        if (term.trim()) {
          chain = (chain as any).search(term);
        }
        continue;
      }

      const args = this._sanitizeStepArgs(step, validColumns, modelClass.type);

      // Skip empty where({}) — sanitizer returns [] to signal "no-op"
      if (args.length === 0 && step.method !== "limit") continue;

      // Clamp limit
      if (step.method === "limit") {
        hasLimit = true;
        args[0] = Math.min(
          Math.max(Number.parseInt(args[0]) || BackendAdapter.DEFAULT_LIMIT, 1),
          BackendAdapter.MAX_LIMIT,
        );
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

  private _buildQuery<T>(
    modelClass: ModelConstructor<T>,
    knexQuery: any,
  ): QueryChain<T> {
    const chain: any = {};

    for (const method of CHAINABLE_METHODS) {
      chain[method] = (...args: any[]) => {
        return this._buildQuery(modelClass, knexQuery[method](...args));
      };
    }

    // search() — applies hybrid full-text + fuzzy search SQL
    chain.search = (term: string) => {
      const searchFields = (modelClass as any).searchFields as
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
      const result = await clone.clearSelect().count(column || "*");
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
    const schema = ((ModelClass as any).__schema as SchemaDefinition) ?? {};

    // ── SQLite: read-modify-write (no native JSONB operators) ──────
    if (this.isSqlite) {
      await this._patchSqlite(model, ops, table, schema);
      return;
    }

    await this.runHooks(model, "patch", "before");

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
        if (!equal(actual, (o as any).value)) {
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

      // Scalar columns: direct value SET
      if (colType !== "json") {
        const lastOp = columnOps[columnOps.length - 1]!;
        if (lastOp.op.op === "test") continue;
        const value = (lastOp.op as any).value;
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

      for (const { op: o, innerSegments } of columnOps) {
        switch (o.op) {
          case "add": {
            if (innerSegments[innerSegments.length - 1] === "-") {
              const parent = innerSegments.slice(0, -1);
              this._ensureIntermediates(parent, column, ensured, (pgPath) => {
                sql = `jsonb_set_lax(${sql}, ?::text[], COALESCE((COALESCE(${column}, '{}'::jsonb)) #> ?::text[], '[]'::jsonb), true, 'use_json_null')`;
                bindings.push(pgPath, pgPath);
              });
              sql = `jsonb_insert(${sql}, ?::text[], ?::jsonb, true)`;
              bindings.push(
                `{${[...parent, "-1"].join(",")}}`,
                JSON.stringify((o as any).value),
              );
            } else if (innerSegments.length === 0) {
              sql = "?::jsonb";
              bindings.push(JSON.stringify((o as any).value));
            } else {
              this._ensureIntermediates(
                innerSegments,
                column,
                ensured,
                (pgPath) => {
                  sql = `jsonb_set_lax(${sql}, ?::text[], COALESCE((COALESCE(${column}, '{}'::jsonb)) #> ?::text[], '{}'::jsonb), true, 'use_json_null')`;
                  bindings.push(pgPath, pgPath);
                },
              );
              sql = `jsonb_set_lax(${sql}, ?::text[], ?::jsonb, true, 'use_json_null')`;
              bindings.push(
                `{${innerSegments.join(",")}}`,
                JSON.stringify((o as any).value),
              );
            }
            break;
          }
          case "replace": {
            if (innerSegments.length === 0) {
              sql = "?::jsonb";
              bindings.push(JSON.stringify((o as any).value));
            } else {
              this._ensureIntermediates(
                innerSegments,
                column,
                ensured,
                (pgPath) => {
                  sql = `jsonb_set_lax(${sql}, ?::text[], COALESCE((COALESCE(${column}, '{}'::jsonb)) #> ?::text[], '{}'::jsonb), true, 'use_json_null')`;
                  bindings.push(pgPath, pgPath);
                },
              );
              sql = `jsonb_set_lax(${sql}, ?::text[], ?::jsonb, true, 'use_json_null')`;
              bindings.push(
                `{${innerSegments.join(",")}}`,
                JSON.stringify((o as any).value),
              );
            }
            break;
          }
          case "remove": {
            if (innerSegments.length === 0) {
              sql = `'{}'::jsonb`;
            } else {
              sql = `(${sql} #- ?::text[])`;
              bindings.push(`{${innerSegments.join(",")}}`);
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

    await this.write(table).where("id", model.id).update(updateFields);
    await this.runHooks(model, "patch", "after");
    this._notifyChange(model);
  }

  private _ensureIntermediates(
    segments: string[],
    column: string,
    ensured: Set<string>,
    emit: (pgPath: string) => void,
  ): void {
    for (let depth = 1; depth < segments.length; depth++) {
      const key = `${column}:${segments.slice(0, depth).join(",")}`;
      if (!ensured.has(key)) {
        ensured.add(key);
        emit(`{${segments.slice(0, depth).join(",")}}`);
      }
    }
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
    await this.runHooks(model, "patch", "before");

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
        const value = (lastOp as any).value;
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

    await this.write(table).where("id", model.id).update(updateFields);
    await this.runHooks(model, "patch", "after");
    this._notifyChange(model);
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

  // ── Hooks ────────────────────────────────────────────────────────────

  async runHooks(
    model: any,
    action: string,
    timing: string,
    extra?: {
      data?: Record<string, any>;
      user?: { id: string; [key: string]: any } | null;
    },
  ): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    const hooks = getHooksFor(
      ModelClass.type,
      timing as HookTiming,
      action as HookAction,
    );

    for (const hookEntry of hooks) {
      const ctx = {
        model,
        action: action as HookAction,
        data: extra?.data,
        user: extra?.user,
        lock: globalLock,
        enqueue: globalEnqueue,
      };

      if (hookEntry.async) {
        Promise.resolve(hookEntry.handler(ctx)).catch((err) => {
          log.error(
            `[hook] Async error in ${hookEntry.modelType}:${action}:`,
            err,
          );
        });
      } else {
        await hookEntry.handler(ctx);
      }
    }
  }

  // ── Schema Management ────────────────────────────────────────────────

  async ensureTable(modelClass: ModelConstructor): Promise<void> {
    if ((modelClass as any).managed === false) {
      log.info(
        `skipping schema — model=${modelClass.type} (externally managed)`,
      );
      return;
    }

    const table = tableName(modelClass);
    const schema = ((modelClass as any).__schema as SchemaDefinition) ?? {};
    const indexes = (modelClass as any).indexes || [];

    log.info(`ensuring schema — model=${modelClass.type}`);

    const hasTable = await this.write.schema.hasTable(table);

    const existingColumns: string[] = [];
    if (hasTable) {
      for (const key of Object.keys(schema)) {
        if (await this.write.schema.hasColumn(table, key))
          existingColumns.push(key);
      }
      for (const sys of ["createdAt", "updatedAt"]) {
        if (await this.write.schema.hasColumn(table, sys))
          existingColumns.push(sys);
      }
    }

    let existingIndexes: string[] = [];
    try {
      if (this.isSqlite) {
        const rows = await this.write.raw(
          "SELECT name FROM pragma_index_list(?)",
          [table],
        );
        existingIndexes = (rows ?? []).map((r: any) => r.name);
      } else {
        const result = await this.write.raw(
          "SELECT * FROM pg_indexes WHERE tablename = ?",
          [table],
        );
        existingIndexes = result.rows.map((r: any) => r.indexname);
      }
    } catch {}

    await this.write.schema[hasTable ? "alterTable" : "createTable"](
      table,
      (t: any) => {
        if (!hasTable) {
          t.string("id").primary().unique();
          this.isSqlite ? t.text("data") : t.jsonb("data");
          t.datetime("createdAt");
          t.datetime("updatedAt");
        }

        const originalIndex = t.index.bind(t);
        t.index = (cols: any, name: string, ...args: any[]) => {
          const prefixed = `${table}_${name || (Array.isArray(cols) ? cols.join("_") : cols)}`;
          if (!existingIndexes.includes(prefixed))
            originalIndex(cols, prefixed, ...args);
        };

        t.index("createdAt", "createdAt");
        t.index("updatedAt", "updatedAt");

        for (const [key, colDef] of Object.entries(schema)) {
          if (existingColumns.includes(key)) continue;
          if (["createdAt", "updatedAt", "data", "id"].includes(key)) continue;

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
    const searchFields = (modelClass as any).searchFields as
      | string[]
      | undefined;
    if (searchFields?.length) {
      await this._ensureSearchSchema(table, searchFields);
    }
  }

  /**
   * Create search-related columns and indexes for a table.
   * Called from ensureTable() when the model has `static searchFields`.
   */
  private async _ensureSearchSchema(
    table: string,
    fields: string[],
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
    const hasSearch = await this.write.schema.hasColumn(table, "_search");
    if (!hasSearch) {
      await this.write.raw(
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
      await this.write.raw(
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
        await this.write.raw(
          `
          CREATE INDEX IF NOT EXISTS ?? ON ?? USING gin(?? gin_trgm_ops)
        `,
          [trgmIdxName, table, field],
        );
      } catch {}
    }

    // 3. AlloyDB: vector embedding column + ScaNN index
    if (this.engine === "alloydb") {
      const hasEmbedding = await this.write.schema.hasColumn(
        table,
        "_embedding",
      );
      if (!hasEmbedding) {
        await this.write.raw(
          "ALTER TABLE ?? ADD COLUMN _embedding vector(768)",
          [table],
        );
        log.info(
          `search: added _embedding vector(768) column — table=${table}`,
        );
      }

      const embIdxName = `${table}__embedding_scann`;
      try {
        await this.write.raw(
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
      const searchFields = (modelClass as any).searchFields as
        | string[]
        | undefined;
      if (!searchFields?.length) continue;
      if ((modelClass as any).managed === false) continue;

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
