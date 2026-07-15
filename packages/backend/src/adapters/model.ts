import { log } from "../logger";
import { detectEngine } from "./engine";
import { loadCachedSchemas } from "../schema/generate";

/**
 * BackendAdapter — Knex + Postgres persistence for Parcae Model.
 *
 * Uses ts-morph-resolved schemas (resolved at startup, cached to
 * `.parcae/schema.json`) to map Model classes to Postgres columns,
 * plus Parcae's hook and subscription systems.
 */

import {
  CHAINABLE_METHODS,
  isArrayIndexSegment,
  SYM_SERVER_MERGE,
  type ColumnType,
  type ModelAdapter,
  type ModelConstructor,
  type QueryChain,
  type QueryStep,
  type SchemaDefinition,
} from "@parcae/model";
import {
  dateSafeClone,
  generateId,
  type Model,
  type WithRefs,
} from "@parcae/model";
import type { QuerySubscriptionManager } from "../services/subscriptions";
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
  getRefLoader,
  getRequestUser,
  getRuntimeFlags,
} from "../services/context";
import {
  activeTransactionHandle,
  runAfterCommitIfActive,
  runAfterRollbackIfActive,
  withTransaction,
} from "../services/transactionContext";
import {
  ensureChangeTriggers,
  verifyChangeTriggers,
} from "../services/change-triggers";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BackendServices {
  read: any; // Knex read replica
  write: any; // Knex primary
}

/**
 * Cached snapshot of the live database schema, built once at the top
 * of `ensureAllTables()` and consumed by every per-model `ensureTable()`
 * call. This replaces the previous O(models × columns) sequential
 * `hasColumn` / `hasIndex` round-trips with a small fixed number of
 * bulk queries against Postgres `information_schema` and `pg_indexes`.
 *
 * The snapshot is **read-only**. DDL emitted during `ensureTable()` is
 * NOT reflected back into the cache — the cache exists to answer "does
 * column X exist on table Y *as of the start of this boot*". Any
 * follow-up code that needs to see newly-added columns (e.g.
 * `_ensureSearchSchema`'s checks for `_search` / `_embedding`) still
 * queries the database directly so it observes its own writes.
 */
interface BulkIntrospection {
  tables: Set<string>;
  /** Map from table name to the set of column names that table exposes. */
  columns: Map<string, Set<string>>;
  /** Map from table name to the set of index names that table exposes. */
  indexes: Map<string, Set<string>>;
}

/**
 * Columns parcae always considers its own — never droppable as
 * "obsolete" even when the model no longer declares them, and even
 * when `PARCAE_DROP_OBSOLETE_COLUMNS=true` is set. This covers:
 *
 *   - Primary key + bookkeeping: `id`, `createdAt`, `updatedAt`, `tmp`
 *   - JSONB overflow column: `data`
 *   - Search columns from `static searchFields`: `_search`, `_embedding`
 *
 * Note: `_search` / `_embedding` are kept on the protected list even
 * if the model has dropped `static searchFields` since their last
 * boot. Reverting search is an explicit migration operation; we don't
 * destroy them as a side-effect of a code change.
 */
const PARCAE_OWNED_COLUMNS: ReadonlySet<string> = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "tmp",
  "data",
  "_search",
  "_embedding",
]);

const SYSTEM_DATA_KEYS = new Set([
  "id",
  "type",
  "createdAt",
  "updatedAt",
  "tmp",
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tableName(modelClass: ModelConstructor): string {
  return pluralize(modelClass.type);
}

function parsePatchPath(path: string): string[] {
  if (!path.startsWith("/")) {
    throw new ClientError(`patch: invalid path "${path}"`);
  }
  return path
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function assertSupportedPatchOps(ops: readonly PatchOp[]): void {
  for (const op of ops) {
    if (op.op === "copy" || op.op === "move") {
      throw new ClientError(`patch: unsupported op "${op.op}"`);
    }
    if (
      op.op !== "add" &&
      op.op !== "replace" &&
      op.op !== "remove" &&
      op.op !== "test"
    ) {
      throw new ClientError(
        `patch: unsupported op "${String((op as { op?: unknown }).op)}"`,
      );
    }
    parsePatchPath(op.path);
  }
}

function encodePatchSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function prefixPatchOps(field: string, ops: readonly PatchOp[]): PatchOp[] {
  const prefix = `/${encodePatchSegment(field)}`;
  return ops.map((op) => ({
    ...op,
    path: `${prefix}${op.path}`,
    ...((op.op === "copy" || op.op === "move")
      ? { from: `${prefix}${op.from}` }
      : {}),
  })) as PatchOp[];
}

function overflowData(
  data: Record<string, any>,
  schema: SchemaDefinition,
): Record<string, any> {
  const overflow: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SYSTEM_DATA_KEYS.has(key) || key in schema) continue;
    overflow[key] = value;
  }
  return overflow;
}

function saveState(
  data: Record<string, any>,
  schema: SchemaDefinition,
): Record<string, any> {
  return {
    ...data,
    data: overflowData(data, schema),
  };
}

function saveConflictTests(
  state: Record<string, any>,
  schema: SchemaDefinition,
  ops: readonly PatchOp[],
): PatchOp[] {
  const tests = new Map<string, PatchOp>();
  const addTest = (segments: string[], value: unknown): void => {
    const path = `/${segments.map(encodePatchSegment).join("/")}`;
    tests.set(path, { op: "test", path, value: dateSafeClone(value) });
  };

  for (const op of ops) {
    const segments = parsePatchPath(op.path);
    const field = segments[0]!;
    if (resolveColType(schema[field]!) !== "json") continue;
    const inner = segments.slice(1);
    if (inner.length === 0) {
      addTest([field], state[field]);
      continue;
    }

    let cursor = state[field];
    const path = [field];
    for (const segment of inner) {
      if (Array.isArray(cursor)) {
        addTest(path, cursor);
        break;
      }
      if (cursor === null || typeof cursor !== "object") break;
      cursor = cursor[segment];
      path.push(segment);
    }
    if (Array.isArray(cursor)) addTest(path, cursor);
  }

  return [...tests.values(), ...ops];
}

function saveDiff(
  schema: SchemaDefinition,
  before: Record<string, any>,
  after: Record<string, any>,
): {
  ops: PatchOp[];
  patchSchema: SchemaDefinition;
} {
  const state = saveState(before, schema);
  const current = saveState(after, schema);
  const patchSchema: SchemaDefinition = {
    ...schema,
    tmp: "string",
    data: "json",
  };
  const ops: PatchOp[] = [];
  for (const [field, column] of Object.entries(patchSchema)) {
    const previous = state[field];
    const next = current[field];
    if (equal(previous, next, { strict: true })) continue;
    if (resolveColType(column) === "json") {
      if (previous === undefined) {
        ops.push({ op: "add", path: `/${encodePatchSegment(field)}`, value: next });
      } else if (next === undefined) {
        ops.push({ op: "remove", path: `/${encodePatchSegment(field)}` });
      } else if (
        previous !== null &&
        next !== null &&
        typeof previous === "object" &&
        typeof next === "object"
      ) {
        ops.push(
          ...prefixPatchOps(
            field,
            fastJsonPatch.compare(
              dateSafeClone(previous),
              dateSafeClone(next),
            ),
          ),
        );
      } else {
        ops.push({
          op: "replace",
          path: `/${encodePatchSegment(field)}`,
          value: next,
        });
      }
      continue;
    }
    ops.push(
      next === undefined
        ? { op: "remove", path: `/${encodePatchSegment(field)}` }
        : {
            op: previous === undefined ? "add" : "replace",
            path: `/${encodePatchSegment(field)}`,
            value: next,
          },
    );
  }
  return {
    ops: saveConflictTests(state, patchSchema, ops),
    patchSchema,
  };
}

/** Resolve a ColumnType to a primitive string type. */
function resolveColType(col: ColumnType): string {
  if (typeof col === "string") return col;
  if (col.kind === "ref") return "string"; // refs stored as VARCHAR ID
  return "json";
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
function hydrate<T extends Model>(
  modelClass: ModelConstructor<T>,
  adapter: BackendAdapter,
  row: Record<string, any>,
): WithRefs<T> {
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
  // - json: legacy text values are parsed defensively; jsonb is already parsed.
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
  return (modelClass as any).hydrate(adapter, data) as WithRefs<T>;
}

/**
 * Serialize model data for DB insert/update.
 * Splits into declared columns + overflow `data` JSONB blob.
 */
function serialize(
  model: any,
  raw: Record<string, any> = model.__data,
): Record<string, any> {
  const ModelClass = model.constructor as typeof Model;
  const schema =
    (ModelClass.__schema as SchemaDefinition | undefined) ?? {};

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
  for (const [key, value] of Object.entries(raw)) {
    if (SYSTEM_DATA_KEYS.has(key)) continue;
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
  public subscriptions: QuerySubscriptionManager | null = null;

  /** Registered model constructors, keyed by type. Set via registerModels(). */
  private _models = new Map<string, ModelConstructor>();

  /** Detected database engine — set by detectEngine(). */
  public engine: "alloydb" | "postgres" = "postgres";

  /** Whether search extensions have been enabled for this database. */
  private _searchExtensionsReady = false;

  /** Tables that have a verified _embedding column (AlloyDB only). */
  private _embeddingReady = new Set<string>();

  get read() {
    return activeTransactionHandle() ?? this.services.read;
  }
  get write() {
    return activeTransactionHandle() ?? this.services.write;
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

  get modelsByType(): Map<string, ModelConstructor> {
    return this._models;
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
   * Detect AlloyDB or standard Postgres. Called once before schema setup.
   */
  async detectEngine(): Promise<"alloydb" | "postgres"> {
    this.engine = await detectEngine(this.write);
    log.info(`Database engine detected: ${this.engine}`);
    return this.engine;
  }

  // ── Search Extensions ───────────────────────────────────────────────

  /**
   * Enable search extensions (idempotent). Called once when the first
   * model with `static searchFields` is encountered during ensureTable().
   */
  private async _ensureSearchExtensions(): Promise<void> {
    if (this._searchExtensionsReady) return;

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

  private _withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return withTransaction({ knex: this.services.write }, fn);
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

  // ── save ─────────────────────────────────────────────────────────────

  /**
   * Persist one captured model state. New instances insert the complete row;
   * existing instances diff against their last server snapshot so unrelated
   * concurrent JSONB edits survive.
   */
  async save(
    model: any,
    data: Record<string, any> = model.__data,
  ): Promise<Record<string, any>> {
    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);
    const creating = Boolean((model as any).__isNew);
    const action = creating ? "create" : "save";
    const cleanups: Array<() => Promise<void> | void> = [];
    const operationModel = this._captureSaveModel(model, data, creating);
    const serverSnapshot = structuredClone(model.__serverSnapshot ?? data);
    let persistedData: Record<string, any>;

    try {
      persistedData = await this._withTransaction(async () => {
        await this.runHooks(operationModel, action, "before", { cleanups });

        (operationModel as any).updatedAt = new Date();
        if (creating && !(operationModel as any).createdAt) {
          (operationModel as any).createdAt = new Date();
        }

        const writeData = structuredClone(operationModel.__data);
        if (creating) {
          const inserted = await this.write(table)
            .insert(serialize(operationModel, writeData))
            .onConflict("id")
            .merge()
            .returning("*");
          const insertedRow = Array.isArray(inserted) ? inserted[0] : inserted;
          if (!insertedRow) {
            throw new ClientError(`save: row not found id=${operationModel.id}`);
          }
          persistedData =
            typeof (ModelClass as any).hydrate === "function"
              ? (hydrate(
                  ModelClass as unknown as ModelConstructor,
                  this,
                  insertedRow,
                ) as any).__data
              : {
                  ...writeData,
                  id: insertedRow.id ?? operationModel.id,
                  createdAt: insertedRow.createdAt ?? writeData.createdAt,
                  updatedAt: insertedRow.updatedAt ?? writeData.updatedAt,
                };
        } else {
          const schema = (ModelClass.__schema as SchemaDefinition) ?? {};
          const { ops, patchSchema } = saveDiff(
            schema,
            serverSnapshot,
            writeData,
          );
          persistedData = await this._patchPostgres(
            operationModel,
            ops,
            table,
            patchSchema,
            cleanups,
            {
              lockRow: true,
              runHooks: false,
              testFailureStatus: 409,
            },
          );
        }

        if (typeof operationModel[SYM_SERVER_MERGE] === "function") {
          operationModel[SYM_SERVER_MERGE](persistedData, writeData);
        } else {
          this._replaceOperationData(operationModel, persistedData);
        }
        await this.runHooks(operationModel, action, "after", { cleanups });
        return persistedData;
      });
    } catch (err) {
      await this._runCleanups(cleanups, `${ModelClass.type}:${action}`);
      throw err;
    }

    this._retainCleanupsForOuterRollback(
      cleanups,
      `${ModelClass.type}:${action}`,
    );
    log.debug(`model saved model=${ModelClass.type}, id=${model.id}`);
    return persistedData;
  }

  // ── remove ───────────────────────────────────────────────────────────

  async remove(model: any): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);
    const cleanups: Array<() => Promise<void> | void> = [];

    try {
      await this._withTransaction(async () => {
        await this.runHooks(model, "remove", "before", { cleanups });
        await this.write(table).where("id", model.id).del();
        await this.runHooks(model, "remove", "after", { cleanups });
      });
    } catch (err) {
      await this._runCleanups(cleanups, `${ModelClass.type}:remove`);
      throw err;
    }
    this._retainCleanupsForOuterRollback(
      cleanups,
      `${ModelClass.type}:remove`,
    );
  }

  // ── findById ─────────────────────────────────────────────────────────

  async findById<T extends Model>(
    modelClass: ModelConstructor<T>,
    id: string,
  ): Promise<WithRefs<T> | null> {
    if (!id) return null;
    // When called inside an `app.start()`-installed request scope, a
    // RefLoader is attached to the AsyncLocalStorage frame. Defer to
    // it so concurrent ref resolutions in the same microtask coalesce
    // into one `WHERE id IN (...)` batch instead of N
    // sequential `WHERE id = ?` lookups. Outside a request (jobs,
    // hook handlers without a request frame, tests) we fall through
    // to the direct path. See `services/ref-loader.ts`.
    const loader = getRefLoader();
    if (loader) {
      const row = await loader.load(modelClass.type, id);
      return (row as WithRefs<T> | null) ?? null;
    }
    const row = await this.read(tableName(modelClass))
      .select("*")
      .where("id", id)
      .first();
    return row ? hydrate(modelClass, this, row) : null;
  }

  /**
   * Fetch many rows of one type by id in a single query and return a
   * `Map<id, hydratedModel>`. Missing ids are simply absent from the
   * map — callers can default to `null`. Empty id lists short-circuit
   * without touching the database; unknown model types resolve to an
   * empty map rather than throwing.
   *
   * This is the batch entry point the request-scoped `RefLoader`
   * calls; it's also useful directly when you have a known list of
   * ids and want to avoid the per-id round-trip dance manually.
   */
  async batchFindByType(
    type: string,
    ids: string[],
  ): Promise<Map<string, any>> {
    return this._batchFindByType(this.read, type, ids);
  }

  /** @internal Primary-backed ref hydration for subscription caches. */
  async batchFindByTypeOnWrite(
    type: string,
    ids: string[],
  ): Promise<Map<string, any>> {
    return this._batchFindByType(this.write, type, ids);
  }

  private async _batchFindByType(
    db: any,
    type: string,
    ids: string[],
  ): Promise<Map<string, any>> {
    const result = new Map<string, any>();
    if (ids.length === 0) return result;

    const modelClass = this._models.get(type);
    if (!modelClass) return result;

    const uniqueIds = Array.from(new Set(ids));
    const rows = await db(tableName(modelClass))
      .select("*")
      .whereIn("id", uniqueIds);
    for (const row of rows ?? []) {
      const hydrated = hydrate(modelClass, this, row);
      result.set((hydrated as any).id, hydrated);
    }
    return result;
  }

  // ── query ────────────────────────────────────────────────────────────

  query<T extends Model>(modelClass: ModelConstructor<T>): QueryChain<WithRefs<T>> {
    return this._buildQuery(modelClass, this.read(tableName(modelClass)));
  }

  /** @internal Execute a compiled subscription query on the primary. */
  async executeSubscriptionQuery(query: QueryChain<any>): Promise<any[]> {
    const compiled = query.exec().toSQL();
    const response = await this.write.raw(compiled.sql, compiled.bindings);
    const rows = response?.rows ?? response ?? [];
    return rows.map((row: Record<string, any>) =>
      hydrate(query.__modelClass, this, row),
    );
  }

  /** @internal Count a subscribed query on the same primary snapshot source. */
  async executeSubscriptionCount(query: QueryChain<any>): Promise<number> {
    const compiled = query
      .exec()
      .clone()
      .clearSelect()
      .clearOrder()
      .clear("limit")
      .clear("offset")
      .count("*")
      .toSQL();
    const response = await this.write.raw(compiled.sql, compiled.bindings);
    const row = (response?.rows ?? response ?? [])[0] ?? {};
    return Number.parseInt(`${Object.values(row)[0] ?? 0}`, 10);
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

  private static CLIENT_PREDICATE_METHODS = new Set([
    "where",
    "andWhere",
    "orWhere",
    "whereIn",
    "whereNot",
    "whereNotIn",
    "whereNull",
    "whereNotNull",
    "whereBetween",
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
    // Wrap each value in a one-element JSON array so
    // `@>` is true iff the column's array contains that value.
    const parts = values.map(() => `?? @> ?::jsonb`).join(" OR ");
    const bindings: any[] = [];
    for (const v of values) {
      bindings.push(colName, JSON.stringify([v]));
    }
    return c.whereRaw(`(${parts})`, bindings);
  }

  queryFromClient<T extends Model>(
    modelClass: ModelConstructor<T>,
    scope: Record<string, any>,
    rawSteps: QueryStep[] | string | undefined,
  ): QueryChain<WithRefs<T>> {
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
    let chain: QueryChain<WithRefs<T>>;
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

    const predicates: Array<{ step: QueryStep; args: any[] }> = [];
    for (const step of steps) {
      if (!BackendAdapter.CLIENT_PREDICATE_METHODS.has(step.method)) continue;
      const args = this._sanitizeStepArgs(
        step,
        validColumns,
        modelClass.type,
        schema,
      );
      if (args.length > 0) predicates.push({ step, args });
    }

    let groupedPredicates = false;

    for (const step of steps) {
      if (!BackendAdapter.SAFE_CLIENT_METHODS.has(step.method)) continue;

      if (BackendAdapter.CLIENT_PREDICATE_METHODS.has(step.method)) {
        if (!groupedPredicates && predicates.length > 0) {
          chain = chain.where((builder: any) => {
            for (const predicate of predicates) {
              const { args } = predicate;
              if (
                typeof args[0] === "string" &&
                args[0].startsWith("__rewrite:")
              ) {
                const method = args[0].slice("__rewrite:".length);
                builder = builder[method](args[1], args[2]);
                continue;
              }
              if (
                (predicate.step.method === "whereIn" ||
                  predicate.step.method === "orWhereIn") &&
                this._isJsonArrayColumn(modelClass, args[0], schema)
              ) {
                builder = this._applyJsonArrayWhereIn(
                  builder,
                  args[0] as string,
                  args[1] as any[],
                );
                continue;
              }
              builder = builder[predicate.step.method](...args);
            }
          });
          groupedPredicates = true;
        }
        continue;
      }

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

  private _buildQuery<T extends Model>(
    modelClass: ModelConstructor<T>,
    knexQuery: any,
    expand: readonly string[] = [],
  ): QueryChain<WithRefs<T>> {
    const chain: any = {};

    for (const method of CHAINABLE_METHODS) {
      chain[method] = (...args: any[]) => {
        // expand() — records ref field projections for the route /
        // subscription layer to apply after `.find()`. Not a SQL
        // operation; never reaches Knex. Stored as a sidecar list
        // on the chain so `routes.ts` / `subscriptions.ts` can
        // recover the projection without re-walking `__steps`.
        if (method === "expand") {
          const additions = args
            .filter((a): a is string => typeof a === "string" && a.length > 0);
          return this._buildQuery(
            modelClass,
            knexQuery,
            additions.length > 0 ? [...expand, ...additions] : expand,
          );
        }
        // orderBy(false) — opt the query out of order envelope
        // emission. Records the step in `__steps` (read by the
        // subscriptions manager via `orderEmissionDisabled`) but
        // never touches Knex.
        if (method === "orderBy" && args.length === 1 && args[0] === false) {
          return this._buildQuery(modelClass, knexQuery, expand);
        }
        if (method === "clearLimit") {
          return this._buildQuery(
            modelClass,
            knexQuery.clear("limit"),
            expand,
          );
        }
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
              expand,
            );
          }
        }
        return this._buildQuery(
          modelClass,
          knexQuery[method](...args),
          expand,
        );
      };
    }

    // search() — applies hybrid full-text + fuzzy search SQL
    chain.search = (term: string) => {
      const searchFields = modelClass.searchFields as
        | string[]
        | undefined;
      if (!searchFields?.length || !term.trim()) {
        return this._buildQuery(modelClass, knexQuery, expand);
      }
      const modified = this._applySearch(knexQuery, term, modelClass);
      return this._buildQuery(modelClass, modified, expand);
    };

    chain.find = async (): Promise<WithRefs<T>[]> => {
      const rows = await knexQuery;
      return Array.isArray(rows)
        ? rows.map((row: any) => hydrate(modelClass, this, row))
        : [];
    };

    chain.first = async (): Promise<WithRefs<T> | null> => {
      const row = await knexQuery.first();
      return row ? hydrate(modelClass, this, row) : null;
    };

    chain.count = async (column?: string): Promise<number> => {
      const clone = knexQuery.clone();
      const result = await clone
        .clearSelect()
        .clearOrder()
        .clear("limit")
        .clear("offset")
        .count(column || "*");
      return Number.parseInt(`${Object.values(result[0] || {})[0] || "0"}`, 10);
    };

    chain.sum = async (column: string): Promise<number> => {
      const clone = knexQuery.clone();
      const result = await clone
        .clearSelect()
        .clearOrder()
        .clear("limit")
        .clear("offset")
        .sum({ total: column });
      const total = Number(Object.values(result[0] || {})[0] ?? 0);
      return Number.isFinite(total) ? total : 0;
    };

    chain.exec = () => knexQuery;
    chain.clone = () => this._buildQuery(modelClass, knexQuery.clone(), expand);

    // Internal metadata — used by subscription manager for type indexing
    chain.__modelType = modelClass.type;
    chain.__modelClass = modelClass;
    chain.__adapter = this;
    // `.expand(...)` projections recorded for the route / subscription
    // layer to apply after `.find()`. Empty when the caller did not
    // opt in — preserves the current "string-id-only" wire shape.
    chain.__expand = expand;

    return chain as QueryChain<WithRefs<T>>;
  }

  // ── patch (atomic JSONB SQL) ─────────────────────────────────────────

  async patch(
    model: any,
    ops: PatchOp[],
    _data: Record<string, any> = model.__data,
  ): Promise<Record<string, any> | void> {
    if (!ops.length) return;
    assertSupportedPatchOps(ops);

    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);
    const schema = (ModelClass.__schema as SchemaDefinition) ?? {};

    const cleanups: Array<() => Promise<void> | void> = [];

    try {
      const persistedData = await this._withTransaction(async () => {
        return await this._patchPostgres(model, ops, table, schema, cleanups);
      });
      this._retainCleanupsForOuterRollback(
        cleanups,
        `${ModelClass.type}:patch`,
      );
      return persistedData;
    } catch (err) {
      await this._runCleanups(cleanups, `${ModelClass.type}:patch`);
      throw err;
    }
  }

  private async _patchPostgres(
    model: any,
    ops: PatchOp[],
    table: string,
    schema: SchemaDefinition,
    cleanups: Array<() => Promise<void> | void>,
    options: {
      lockRow?: boolean;
      runHooks?: boolean;
      testFailureStatus?: number;
    } = {},
  ): Promise<Record<string, any>> {
    const ModelClass = model.constructor as typeof Model;
    if (options.runHooks !== false) {
      await this.runHooks(model, "patch", "before", {
        data: { ops },
        cleanups,
      });
    }

    let patchState = model.__serverSnapshot ?? model.__data;
    if (options.lockRow || ops.some((op) => op.op === "test")) {
      const currentRow = await this.write(table)
        .where("id", model.id)
        .forUpdate()
        .first();
      if (!currentRow) {
        throw new ClientError(`patch: row not found id=${model.id}`);
      }
      const currentData = (hydrate(
        ModelClass as unknown as ModelConstructor,
        this,
        currentRow,
      ) as any).__data;
      patchState = saveState(currentData, schema);
    }
    this._validatePatchTests(
      patchState,
      ops,
      options.testFailureStatus,
    );

    type ParsedOp = {
      op: PatchOp;
      column: string;
      colType: string;
      innerSegments: string[];
    };

    const parsed: ParsedOp[] = [];
    const VALID_COLUMN_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

    for (const o of ops) {
      const segments = parsePatchPath(o.path);
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
      let sql = `COALESCE(??, '{}'::jsonb)`;
      const bindings: any[] = [column];
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
      const preState: any = patchState[column] ?? null;
      // Tracks paths whose subtree was removed earlier in THIS batch.
      // Subsequent ensures targeting these paths must still emit so
      // the leaf set has a parent to land on. The "" sentinel marks
      // a root-wipe (`remove /` or root replace) — every subsequent
      // path needs an ensure regardless of pre-state.
      const removedPaths = new Set<string>();

      const ancestorOrSelfRemoved = (segments: string[]): boolean => {
        if (removedPaths.has("")) return true;
        for (let d = 1; d <= segments.length; d++) {
          if (removedPaths.has(JSON.stringify(segments.slice(0, d)))) {
            return true;
          }
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
              // hardcoded `'[]'::jsonb` as the append default.
              // The pre-state-aware ensure skips intermediates that
              // already exist on the row and weren't removed earlier
              // in this batch, preserving any prior mutations.
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
                [...parent, "-1"],
                JSON.stringify(o.value),
              );
            } else if (innerSegments.length === 0) {
              sql = "?::jsonb";
              bindings.length = 0;
              bindings.push(JSON.stringify(o.value));
              // Root replace — every future path starts from this
              // new value. Treat it like a root-wipe for ensure
              // tracking; pre-state is irrelevant.
              removedPaths.clear();
              removedPaths.add("");
            } else if (/^(0|[1-9]\d*)$/.test(innerSegments.at(-1) ?? "")) {
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
              sql = `jsonb_insert(${sql}, ?::text[], ?::jsonb, false)`;
              bindings.push(innerSegments, JSON.stringify(o.value));
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
                innerSegments,
                JSON.stringify(o.value),
              );
            }
            break;
          }
          case "replace": {
            // `case "replace"` narrows `o` to ReplaceOperation<any>.
            if (innerSegments.length === 0) {
              sql = "?::jsonb";
              bindings.length = 0;
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
                innerSegments,
                JSON.stringify(o.value),
              );
            }
            break;
          }
          case "remove": {
            if (innerSegments.length === 0) {
              sql = `'{}'::jsonb`;
              bindings.length = 0;
              removedPaths.clear();
              removedPaths.add("");
            } else {
              sql = `(${sql} #- ?::text[])`;
              bindings.push(innerSegments);
              removedPaths.add(JSON.stringify(innerSegments));
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
      (k) => k !== "data" && !SYSTEM_DATA_KEYS.has(k) && k in schema,
    );
    if (staleKeys.length > 0) {
      // `data` jsonb column always exists; COALESCE handles the rare
      // row where it's null. `- text[]` removes the listed top-level
      // keys (PostgreSQL ≥ 10).
      updateFields.data = updateFields.data
        ? this.write.raw(`(? - ?::text[])`, [updateFields.data, staleKeys])
        : this.write.raw(`COALESCE(??, '{}'::jsonb) - ?::text[]`, [
            "data",
            staleKeys,
          ]);
    }

    const updated = await this.write(table)
      .where("id", model.id)
      .update(updateFields)
      .returning("*");
    const updatedRow = Array.isArray(updated) ? updated[0] : updated;
    if (!updatedRow) throw new ClientError(`patch: row not found id=${model.id}`);
    if (options.runHooks !== false) {
      await this.runHooks(model, "patch", "after", {
        data: { ops },
        cleanups,
      });
    }
    return (hydrate(
      ModelClass as unknown as ModelConstructor,
      this,
      updatedRow,
    ) as any).__data;
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
   *      column value.
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
    emit: (pgPath: string[], defaultJson: string) => void,
  ): void {
    for (let depth = 1; depth < segments.length; depth++) {
      const path = segments.slice(0, depth);
      const pathKey = JSON.stringify(path);
      if (
        BackendAdapter._pathExistsInData(preState, path) &&
        !ancestorOrSelfRemoved(path)
      ) {
        // Path already lives on the row and isn't under a
        // previously-removed ancestor — the live SQL expression
        // still has it intact. Emitting an ensure would re-read the
        // original column at this path and overwrite any earlier
        // remove ops in this batch.
        continue;
      }
      const key = `${column}:${pathKey}`;
      if (!ensured.has(key)) {
        ensured.add(key);
        const defaultJson = isArrayIndexSegment(segments[depth])
          ? "'[]'::jsonb"
          : "'{}'::jsonb";
        emit(path, defaultJson);
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
    return cursor !== null && typeof cursor === "object";
  }

  private _validatePatchTests(
    data: Record<string, any>,
    ops: PatchOp[],
    failureStatus = 400,
  ): void {
    const state = structuredClone(data);
    for (const op of ops) {
      if (op.op === "test") {
        let actual: any = state;
        for (const segment of parsePatchPath(op.path)) {
          actual = actual?.[segment];
        }
        if (!equal(actual, op.value)) {
          throw new ClientError(`patch test failed at ${op.path}`, failureStatus);
        }
        continue;
      }
      if (op.op !== "add" && op.op !== "replace" && op.op !== "remove") {
        continue;
      }
      const segments = parsePatchPath(op.path);
      let parent = state;
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i]!;
        if (parent[segment] == null || typeof parent[segment] !== "object") {
          parent[segment] = isArrayIndexSegment(segments[i + 1]) ? [] : {};
        }
        parent = parent[segment];
      }
      applyPatch(state, [op], false, true);
    }
  }

  // ── Increment/Decrement ──────────────────────────────────────────────

  async increment(model: any, field: string, amount = 1): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);
    await this._withTransaction(async () => {
      await this.write(table).where("id", model.id).increment(field, amount);
      const row = await this.write(table)
        .where("id", model.id)
        .select(field)
        .first();
      if (row) (model as any)[field] = row[field];
    });
  }

  async decrement(model: any, field: string, amount = 1): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);
    await this._withTransaction(async () => {
      await this.write(table).where("id", model.id).decrement(field, amount);
      const row = await this.write(table)
        .where("id", model.id)
        .select(field)
        .first();
      if (row) (model as any)[field] = row[field];
    });
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
    await this._withTransaction(async () => {
      await this.write(table).whereIn("id", ids).increment(field, amount);
    });
  }

  /**
   * Run `fn` inside a Knex transaction. Returns whatever `fn` returns,
   * or rolls back on any thrown error.
   *
   * Model operations and raw statements both use the same active handle.
   */
  async runInTransaction<T>(
    fn: (trx: any) => Promise<T>,
  ): Promise<T> {
    return this._withTransaction(() => fn(this.write));
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
    // RUN_HOOKS=false: skip dispatch entirely. The hook registry is still
    // populated (so `getHooksFor` would return entries), but worker-only
    // processes that want pure job consumption can opt out of hook side
    // effects. Note: this also means before-hooks that mutate `model`
    // (e.g. `model.title = model.title.trim()`) won't fire.
    if (!getRuntimeFlags().hooks) return;

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
        const dispatch = () => {
          void Promise.resolve()
            .then(() => hookEntry.handler(ctx))
            .catch((err) => {
              log.error(
                `[hook] Async error in ${hookEntry.modelType}:${action}:`,
                err,
              );
            });
        };
        if (!runAfterCommitIfActive(dispatch)) dispatch();
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

  private _retainCleanupsForOuterRollback(
    cleanups: Array<() => Promise<void> | void>,
    label: string,
  ): void {
    if (cleanups.length === 0) return;
    let isPending = true;
    runAfterRollbackIfActive(async () => {
      if (!isPending) return;
      isPending = false;
      await this._runCleanups(cleanups, label);
    });
  }

  private _captureSaveModel(
    model: any,
    data: Record<string, any>,
    creating: boolean,
  ): any {
    const ModelClass = model.constructor as typeof Model;
    if (typeof (ModelClass as any).hydrate === "function") {
      const captured = (ModelClass as any).hydrate(
        this,
        structuredClone(data),
      );
      captured.__isNew = creating;
      return captured;
    }

    const state = structuredClone(data);
    const target = Object.assign(
      Object.create(Object.getPrototypeOf(model)),
      model,
      state,
    );
    Object.defineProperty(target, "__data", {
      configurable: true,
      get: () => state,
    });
    target.__isNew = creating;
    return new Proxy(target, {
      set(object, property, value) {
        Reflect.set(object, property, value);
        if (typeof property === "string" && !property.startsWith("__")) {
          state[property] = value;
        }
        return true;
      },
      deleteProperty(object, property) {
        Reflect.deleteProperty(object, property);
        if (typeof property === "string") delete state[property];
        return true;
      },
    });
  }

  private _replaceOperationData(
    model: any,
    data: Record<string, any>,
  ): void {
    const current = model.__data ?? {};
    for (const key of Object.keys(current)) {
      if (!(key in data)) delete model[key];
    }
    for (const [key, value] of Object.entries(data)) {
      model[key] = structuredClone(value);
    }
  }

  // ── Schema Management ────────────────────────────────────────────────

  /**
   * Bulk-load existing table / column / index metadata for a set of
   * tables in a small fixed number of round-trips. Replaces the
   * previous per-(model × column) sequential `hasColumn` calls and the
   * per-table `pg_indexes` queries, cutting cold start from O(N×C) RTTs
   * to O(1).
   *
   * The returned snapshot is read-only and only reflects schema state
   * at the moment of introspection. Any DDL emitted later in the
   * `ensureTable()` pass is NOT reflected back.
   *
   * Uses one `= ANY(?)` query each against `information_schema` and
   * `pg_indexes`. Empty input returns without touching the database.
   */
  private async _bulkIntrospectSchema(
    tables: string[],
  ): Promise<BulkIntrospection> {
    const result: BulkIntrospection = {
      tables: new Set(),
      columns: new Map(),
      indexes: new Map(),
    };
    if (tables.length === 0) return result;

    const kx = this.write;
    const wantedTables = new Set(tables);

    // Scoped to the current schema so a same-named table elsewhere is ignored.
    const tableRes = await kx.raw(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = ANY(?)`,
      [tables],
    );
    for (const row of tableRes?.rows ?? []) {
      if (wantedTables.has(row.table_name)) result.tables.add(row.table_name);
    }

    const colRes = await kx.raw(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ANY(?)`,
      [tables],
    );
    for (const row of colRes?.rows ?? []) {
      if (!wantedTables.has(row.table_name)) continue;
      let set = result.columns.get(row.table_name);
      if (!set) {
        set = new Set();
        result.columns.set(row.table_name, set);
      }
      set.add(row.column_name);
    }

    const idxRes = await kx.raw(
      `SELECT tablename, indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = ANY(?)`,
      [tables],
    );
    for (const row of idxRes?.rows ?? []) {
      if (!wantedTables.has(row.tablename)) continue;
      let set = result.indexes.get(row.tablename);
      if (!set) {
        set = new Set();
        result.indexes.set(row.tablename, set);
      }
      set.add(row.indexname);
    }

    return result;
  }

  async ensureTable(
    modelClass: ModelConstructor,
    opts: {
      knex?: any;
      /**
       * Pre-fetched schema snapshot. When provided, `ensureTable()`
       * answers `hasTable` / `hasColumn` / `hasIndex` from the cache
       * instead of issuing per-call round-trips. Supplied by
       * `ensureAllTables()`; migration-time `ensureModel()` callers
       * leave it undefined and fall back to per-call queries (which
       * is correct because they run inside a transaction whose row
       * visibility differs from the boot-time cache).
       */
      introspection?: BulkIntrospection;
    } = {},
  ): Promise<void> {
    if (modelClass.managed === false) {
      log.info(
        `skipping schema — model=${modelClass.type} (externally managed)`,
      );
      return;
    }

    // When a migration calls ensureModel, it passes its transactional handle
    // here so DDL runs inside the migration transaction and rolls back with it.
    const kx = opts.knex ?? this.write;

    const table = tableName(modelClass);
    const schema = (modelClass.__schema as SchemaDefinition) ?? {};
    const indexes = modelClass.indexes ?? [];
    const intro = opts.introspection;

    log.info(`ensuring schema — model=${modelClass.type}`);

    // `hasTable` and column/index existence: answered from the cache
    // when ensureAllTables built one, otherwise per-call (preserves
    // migration-time semantics for `ensureModel`).
    const hasTable = intro
      ? intro.tables.has(table)
      : await kx.schema.hasTable(table);

    const existingColumns: string[] = [];
    if (hasTable) {
      if (intro) {
        const cols = intro.columns.get(table);
        if (cols) existingColumns.push(...cols);
      } else {
        for (const key of Object.keys(schema)) {
          if (await kx.schema.hasColumn(table, key))
            existingColumns.push(key);
        }
        for (const sys of ["createdAt", "updatedAt", "tmp"]) {
          if (await kx.schema.hasColumn(table, sys))
            existingColumns.push(sys);
        }
      }
    }

    let existingIndexes: string[] = [];
    if (intro) {
      const idx = intro.indexes.get(table);
      if (idx) existingIndexes = [...idx];
    } else {
      try {
        const result = await kx.raw(
          "SELECT * FROM pg_indexes WHERE tablename = ?",
          [table],
        );
        existingIndexes = result.rows.map((r: any) => r.indexname);
      } catch {}
    }

    // Detect columns that exist in the DB but are no longer declared
    // on the model. Done only when we have a bulk introspection cache
    // (i.e. during ensureAllTables(), not migration-time ensureModel)
    // because the cache gives us the complete column set; migrations
    // typically drop columns explicitly anyway.
    let obsoleteColumns: string[] = [];
    const shouldDropObsolete =
      process.env.PARCAE_DROP_OBSOLETE_COLUMNS === "true";
    if (intro && hasTable && existingColumns.length > 0) {
      const owned = new Set<string>([
        ...Object.keys(schema),
        ...PARCAE_OWNED_COLUMNS,
      ]);
      obsoleteColumns = existingColumns.filter((c) => !owned.has(c));
      if (obsoleteColumns.length > 0) {
        if (shouldDropObsolete) {
          log.info(
            `dropping ${obsoleteColumns.length} obsolete column(s) — table=${table} columns=[${obsoleteColumns.join(", ")}]`,
          );
        } else {
          log.info(
            `obsolete column(s) detected — table=${table} columns=[${obsoleteColumns.join(", ")}] (set PARCAE_DROP_OBSOLETE_COLUMNS=true to remove)`,
          );
        }
      }
    }

    await kx.schema[hasTable ? "alterTable" : "createTable"](
      table,
      (t: any) => {
        if (!hasTable) {
          t.string("id").primary().unique();
          t.jsonb("data");
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
              t.jsonb(key);
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

        // Drop obsolete columns last, after every additive change has
        // been queued. Gated behind PARCAE_DROP_OBSOLETE_COLUMNS so
        // operators opt in to destructive behaviour.
        if (shouldDropObsolete) {
          for (const col of obsoleteColumns) {
            t.dropColumn(col);
          }
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
    await this._ensureSearchExtensions();

    // Weights by field order: A (highest), B, C, D
    const weights = ["A", "B", "C", "D"];
    const tsvectorParts = fields
      .map((field, i) => {
        const weight = weights[Math.min(i, weights.length - 1)];
        return `setweight(to_tsvector('english', coalesce(${field}::text, '')), '${weight}')`;
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
    // Bulk-introspect once for every managed table so the per-model
    // `ensureTable()` calls can answer existence questions from memory.
    // Externally-managed models are excluded — we never inspect or
    // alter their schema. See `BulkIntrospection` for the contract.
    const managed = models.filter((m) => m.managed !== false);
    const managedTables = managed.map((m) => tableName(m));
    const introspection = await this._bulkIntrospectSchema(managedTables);

    for (const modelClass of models) {
      await this.ensureTable(modelClass, { introspection });
    }

    // Register embedding hooks for AlloyDB models with searchFields
    if (this.engine === "alloydb") {
      this._registerEmbeddingHooks(models);
    }

    await this.ensureChangeTriggers(models);
  }

  /** Ensure every framework-managed table emits the sole realtime signal. */
  async ensureChangeTriggers(models: ModelConstructor[]): Promise<void> {
    const changeTables = models
      .filter((modelClass) => modelClass.managed !== false)
      .map(tableName);
    await ensureChangeTriggers({ knex: this.write, tables: changeTables });
  }

  /** Verify out-of-band migrations installed every required trigger. */
  async verifyChangeTriggers(models: ModelConstructor[]): Promise<void> {
    const changeTables = models
      .filter((modelClass) => modelClass.managed !== false)
      .map(tableName);
    await verifyChangeTriggers({ knex: this.write, tables: changeTables });
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
