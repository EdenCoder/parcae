import { log } from "../logger";
/**
 * BackendAdapter — Knex + Postgres persistence for Parcae Model.
 *
 * Extracted from Dollhouse Studio's adapters/model.ts (829 lines).
 * Adapted to use RTTIST-resolved schemas instead of static columns,
 * and Parcae's hook/pubsub systems.
 */

import pluralize from "pluralize";
import equal from "deep-equal";
import { applyPatch, type Operation as PatchOp } from "fast-json-patch";
import { Model, generateId } from "@parcae/model";
import type {
  ModelAdapter,
  ModelConstructor,
  ChangeSet,
  QueryChain,
  SchemaDefinition,
  ColumnType,
} from "@parcae/model";
import { getHooksFor } from "../routing/hook";
import type { HookAction, HookTiming } from "../routing/hook";
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
    model.__data.id = generateId();
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

  private _notifySubscriptions(model: any): void {
    const ModelClass = model.constructor as typeof Model;
    this.subscriptions?.onModelChange(ModelClass.type);
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

    model.__data.updatedAt = new Date();
    if (creating && !model.__data.createdAt) {
      model.__data.createdAt = new Date();
    }

    const row = serialize(model);
    await this.write(table).insert(row).onConflict("id").merge();

    log.info(`model saved model=${ModelClass.type}, id=${model.id}`);

    await this.runHooks(model, creating ? "create" : "save", "after");
    this._notifySubscriptions(model);
  }

  // ── remove ───────────────────────────────────────────────────────────

  async remove(model: any): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);

    await this.runHooks(model, "remove", "before");
    await this.write(table).where("id", model.id).del();
    await this.runHooks(model, "remove", "after");

    this.pubsub?.emit?.(`delete+${ModelClass.type}:${model.id}`, model.__data);
    this._notifySubscriptions(model);
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

  async findByIdWrite<T>(
    modelClass: ModelConstructor<T>,
    id: string,
  ): Promise<T | null> {
    if (!id) return null;
    const row = await this.write(tableName(modelClass))
      .select("*")
      .where("id", id)
      .first();
    return row ? hydrate(modelClass, this, row) : null;
  }

  // ── query ────────────────────────────────────────────────────────────

  query<T>(modelClass: ModelConstructor<T>): QueryChain<T> {
    return this._buildQuery(modelClass, this.read(tableName(modelClass)));
  }

  queryWrite<T>(modelClass: ModelConstructor<T>): QueryChain<T> {
    return this._buildQuery(modelClass, this.write(tableName(modelClass)));
  }

  private _buildQuery<T>(
    modelClass: ModelConstructor<T>,
    knexQuery: any,
  ): QueryChain<T> {
    const adapter = this;

    const CHAINABLE = [
      "select",
      "where",
      "andWhere",
      "orWhere",
      "whereIn",
      "whereNot",
      "whereNotIn",
      "whereNull",
      "whereNotNull",
      "whereBetween",
      "whereRaw",
      "orWhereRaw",
      "orWhereIn",
      "orWhereNull",
      "whereExists",
      "orderBy",
      "orderByRaw",
      "groupBy",
      "groupByRaw",
      "having",
      "havingRaw",
      "limit",
      "offset",
      "distinct",
      "distinctOn",
      "join",
      "innerJoin",
      "leftJoin",
      "rightJoin",
      "clearOrder",
      "clearSelect",
      "from",
      "sum",
      "avg",
      "min",
      "max",
      "increment",
      "decrement",
    ] as const;

    const chain: any = {};

    for (const method of CHAINABLE) {
      chain[method] = (...args: any[]) => {
        return adapter._buildQuery(modelClass, knexQuery[method](...args));
      };
    }

    chain.basic = (
      limit: number = 25,
      sort: string = "createdAt",
      direction: "asc" | "desc" = "desc",
      page: number = 0,
    ) => {
      return adapter._buildQuery(
        modelClass,
        knexQuery
          .orderBy(sort, direction)
          .limit(limit)
          .offset(page * limit),
      );
    };

    chain.find = async (): Promise<T[]> => {
      const rows = await knexQuery;
      return Array.isArray(rows)
        ? rows.map((row: any) => hydrate(modelClass, adapter, row))
        : [];
    };

    chain.first = async (): Promise<T | null> => {
      const row = await knexQuery.first();
      return row ? hydrate(modelClass, adapter, row) : null;
    };

    chain.count = async (column?: string): Promise<number> => {
      const clone = knexQuery.clone();
      const result = await clone.clearSelect().count(column || "*");
      return parseInt(`${Object.values(result[0] || {})[0] || "0"}`, 10);
    };

    chain.exec = () => knexQuery;
    chain.clone = () => adapter._buildQuery(modelClass, knexQuery.clone());

    return chain as QueryChain<T>;
  }

  // ── patch (atomic JSONB SQL) ─────────────────────────────────────────

  async patch(model: any, ops: PatchOp[]): Promise<void> {
    if (!ops.length) return;

    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);
    const schema = ((ModelClass as any).__schema as SchemaDefinition) ?? {};

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
        throw new Error(`patch: invalid column name "${column}"`);
      }
      if (!(column in schema)) {
        throw new Error(
          `patch: unknown column "${column}" on model "${ModelClass.type}"`,
        );
      }

      const colType = resolveColType(schema[column]!);

      if (colType !== "json" && innerSegments.length > 0) {
        throw new Error(
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
          throw new Error(`patch test failed at ${o.path}`);
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
              sql = `?::jsonb`;
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
              sql = `?::jsonb`;
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
            throw new Error(`patch: unsupported op "${o.op}"`);
        }
      }

      updateFields[column] = this.write.raw(sql, bindings);
    }

    await this.write(table).where("id", model.id).update(updateFields);
    await this.runHooks(model, "patch", "after");
    this._notifySubscriptions(model);
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

  // ── Increment/Decrement ──────────────────────────────────────────────

  async increment(
    model: any,
    field: string,
    amount: number = 1,
  ): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);
    await this.write(table).where("id", model.id).increment(field, amount);
    const row = await this.write(table)
      .where("id", model.id)
      .select(field)
      .first();
    if (row) model.__data[field] = row[field];
  }

  async decrement(
    model: any,
    field: string,
    amount: number = 1,
  ): Promise<void> {
    const ModelClass = model.constructor as typeof Model;
    const table = tableName(ModelClass as unknown as ModelConstructor);
    await this.write(table).where("id", model.id).decrement(field, amount);
    const row = await this.write(table)
      .where("id", model.id)
      .select(field)
      .first();
    if (row) model.__data[field] = row[field];
  }

  // ── Hooks ────────────────────────────────────────────────────────────

  async runHooks(
    model: any,
    action: string,
    timing: string,
    extra?: { data?: Record<string, any>; user?: { id: string; [key: string]: any } | null },
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

  // ── Distributed Lock ─────────────────────────────────────────────────

  async lock(id: string, ttl: number = 120000): Promise<(() => void) | null> {
    if (this.pubsub?.lock) return this.pubsub.lock(id, ttl);
    return () => {}; // no-op fallback
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
      const result = await this.write.raw(
        `SELECT * FROM pg_indexes WHERE tablename = ?`,
        [table],
      );
      existingIndexes = result.rows.map((r: any) => r.indexname);
    } catch {}

    await this.write.schema[hasTable ? "alterTable" : "createTable"](
      table,
      (t: any) => {
        if (!hasTable) {
          t.string("id").primary().unique();
          t.jsonb("data");
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
      },
    );

    log.info(`ensured schema — model=${modelClass.type}`);
  }

  async ensureAllTables(models: ModelConstructor[]): Promise<void> {
    for (const modelClass of models) {
      await this.ensureTable(modelClass);
    }
  }

  // ── Raw Knex access ──────────────────────────────────────────────────

  readQuery(modelClass: ModelConstructor): any {
    return this.read(tableName(modelClass));
  }

  writeQuery(modelClass: ModelConstructor): any {
    return this.write(tableName(modelClass));
  }
}

export default BackendAdapter;
