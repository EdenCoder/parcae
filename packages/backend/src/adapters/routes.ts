/**
 * Auto-CRUD Route Generator
 *
 * Generates standard REST routes from Model definitions:
 *   GET    /v1/{type}s       → list (scoped, paginated, sortable)
 *   GET    /v1/{type}s/:id   → get one (scoped)
 *   POST   /v1/{type}s       → create (scoped)
 *   PUT    /v1/{type}s/:id   → update (scoped)
 *   DELETE /v1/{type}s/:id   → delete (scoped)
 *   PATCH  /v1/{type}s/:id   → atomic JSON Patch (scoped)
 *
 * Extracted from Dollhouse Studio's adapters/routes.ts (373 lines).
 */

import pluralize from "pluralize";
import { Model } from "@parcae/model";
import type {
  ModelConstructor,
  ScopeContext,
  SchemaDefinition,
} from "@parcae/model";
import type { BackendAdapter } from "./model";
import { route } from "../routing/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildScopeContext(req: any, res: any): ScopeContext {
  return {
    user: req.session?.user ?? null,
    params: req.params ?? {},
    data: req.body ?? {},
  };
}

function json(res: any, status: number, body: any): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function forbidden(res: any): void {
  json(res, 403, { result: null, success: false, error: "Forbidden" });
}

function notFound(res: any, type: string): void {
  json(res, 404, { result: null, success: false, error: `${type} not found` });
}

function resolvePath(modelClass: ModelConstructor, version: string): string {
  if (modelClass.path) return modelClass.path;
  return `/${version}/${pluralize(modelClass.type)}`;
}

// ─── Route Generator ─────────────────────────────────────────────────────────

/**
 * Register auto-CRUD routes for all models that have scopes defined.
 */
export function registerModelRoutes(
  models: ModelConstructor[],
  adapter: BackendAdapter,
  version: string = "v1",
): number {
  let count = 0;

  for (const ModelClass of models) {
    const scope = ModelClass.scope;
    if (!scope) continue;

    const path = resolvePath(ModelClass, version);
    const type = ModelClass.type;
    const schema = ((ModelClass as any).__schema as SchemaDefinition) ?? {};
    const validColumns = new Set([
      "id",
      "createdAt",
      "updatedAt",
      ...Object.keys(schema),
    ]);

    // ── GET /path — list ───────────────────────────────────────────

    if (scope.read) {
      route.get(path, async (req: any, res: any) => {
        const ctx = buildScopeContext(req, res);
        const scopeResult = scope.read!(ctx);
        if (!scopeResult) return forbidden(res);

        const data = req.query || {};
        const limit = Math.min(parseInt(data.limit) || 25, 100);
        const page = parseInt(data.page) || 0;
        const sort = data.sort || "createdAt";
        const direction = data.direction === "asc" ? "asc" : "desc";

        // Column selection
        let selectCols: any = "*";
        if (data.select && typeof data.select === "string") {
          const requested = data.select
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean);
          const allowed = requested.filter((c: string) => validColumns.has(c));
          if (allowed.length > 0) {
            if (!allowed.includes("id")) allowed.unshift("id");
            selectCols = allowed;
          }
        }

        let query = adapter
          .query(ModelClass)
          .select(selectCols)
          .where(scopeResult);

        // Client-side filters: ?where[field]=value
        if (data.where && typeof data.where === "object") {
          for (const [key, value] of Object.entries(data.where)) {
            if (validColumns.has(key)) query = query.where(key, value);
          }
        }

        // Count query (fork before pagination)
        const countQuery = data.__count === "true" ? query.count() : null;

        const items = await query
          .orderBy(sort, direction as "asc" | "desc")
          .limit(limit)
          .offset(page * limit)
          .find();

        const total = countQuery ? await countQuery : items.length;

        json(res, 200, {
          result: {
            total,
            [type + "s"]: await Promise.all(
              (items as any[]).map(
                (m: any) => m.sanitize?.(ctx.user) ?? m.__data,
              ),
            ),
          },
          success: true,
        });
      });
      count++;
    }

    // ── GET /path/:id — get one ────────────────────────────────────

    if (scope.read) {
      route.get(`${path}/:id`, async (req: any, res: any) => {
        const ctx = buildScopeContext(req, res);
        const scopeResult = scope.read!(ctx);
        if (!scopeResult) return forbidden(res);

        const item = await adapter
          .query(ModelClass)
          .select("*")
          .where("id", req.params.id)
          .where(scopeResult)
          .first();

        if (!item) return notFound(res, type);

        json(res, 200, {
          result:
            (await (item as any).sanitize?.(ctx.user)) ?? (item as any).__data,
          success: true,
        });
      });
      count++;
    }

    // ── POST /path — create ────────────────────────────────────────

    if (scope.create) {
      route.post(path, async (req: any, res: any) => {
        const ctx = buildScopeContext(req, res);
        const scopeData = scope.create!(ctx);
        if (!scopeData) return forbidden(res);

        const data = { ...(req.body || {}), ...scopeData };
        const item = Model.create.call(ModelClass, data) as any;
        await item.save(true);

        json(res, 201, {
          result: (await item.sanitize?.(ctx.user)) ?? item.__data,
          success: true,
        });
      });
      count++;
    }

    // ── PUT /path/:id — update ─────────────────────────────────────

    if (scope.update) {
      route.put(`${path}/:id`, async (req: any, res: any) => {
        const ctx = buildScopeContext(req, res);
        const scopeResult = scope.update!(ctx);
        if (!scopeResult) return forbidden(res);

        const item = await adapter
          .query(ModelClass)
          .select("*")
          .where("id", req.params.id)
          .where(scopeResult)
          .first();

        if (!item) return notFound(res, type);

        const data = req.body || {};
        const systemFields = new Set(["id", "createdAt", "updatedAt", "type"]);
        for (const [key, value] of Object.entries(data)) {
          if (!systemFields.has(key)) {
            (item as any).__data[key] = value;
            (item as any).__updates = (item as any).__updates || [];
            (item as any).__updates.push(key);
          }
        }

        await (item as any).save(true);

        json(res, 200, {
          result:
            (await (item as any).sanitize?.(ctx.user)) ?? (item as any).__data,
          success: true,
        });
      });
      count++;
    }

    // ── DELETE /path/:id — delete ──────────────────────────────────

    if (scope.delete) {
      route.delete(`${path}/:id`, async (req: any, res: any) => {
        const ctx = buildScopeContext(req, res);
        const scopeResult = scope.delete!(ctx);
        if (!scopeResult) return forbidden(res);

        const item = await adapter
          .query(ModelClass)
          .select("*")
          .where("id", req.params.id)
          .where(scopeResult)
          .first();

        if (!item) return notFound(res, type);

        await (item as any).remove();

        json(res, 200, { result: { id: req.params.id }, success: true });
      });
      count++;
    }

    // ── PATCH /path/:id — atomic JSON Patch ────────────────────────

    if (scope.patch || scope.update) {
      route.patch(`${path}/:id`, async (req: any, res: any) => {
        const ctx = buildScopeContext(req, res);
        const scopeResult = (scope.patch ?? scope.update)!(ctx);
        if (!scopeResult) return forbidden(res);

        const data = req.body || {};
        if (!Array.isArray(data.ops) || data.ops.length === 0) {
          return json(res, 400, {
            result: null,
            success: false,
            error: "ops array required",
          });
        }

        const item = await adapter
          .query(ModelClass)
          .select("*")
          .where("id", req.params.id)
          .where(scopeResult)
          .first();

        if (!item) return notFound(res, type);

        await adapter.patch(item as any, data.ops);

        json(res, 200, {
          result:
            (await (item as any).sanitize?.(ctx.user)) ?? (item as any).__data,
          success: true,
        });
      });
      count++;
    }
  }

  return count;
}

export default registerModelRoutes;
