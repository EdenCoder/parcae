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

import type { ModelConstructor, ScopeContext } from "@parcae/model";
import { Model } from "@parcae/model";
import pluralize from "pluralize";
import { ClientError } from "../helpers";
import { log } from "../logger";
import { route } from "../routing/route";
import type { BackendAdapter } from "./model";

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
  version = "v1",
): number {
  let count = 0;

  for (const ModelClass of models) {
    const scope = ModelClass.scope;
    if (!scope) continue;

    const path = resolvePath(ModelClass, version);
    const type = ModelClass.type;

    // ── GET /path — list ───────────────────────────────────────────

    if (scope.read) {
      route.get(path, async (req: any, res: any) => {
        const ctx = buildScopeContext(req, res);
        const scopeResult = scope.read!(ctx);
        if (!scopeResult) return forbidden(res);

        const data = req.query || {};
        const steps = data.__query ?? [];

        try {
          const query = adapter.queryFromClient(ModelClass, scopeResult, steps);

          if (data.__count === "true" || data.__count === true) {
            const total = await query.count();
            return json(res, 200, { result: { total }, success: true });
          }

          // For socket RPC, subscribe to query-level change notifications.
          // The subscription manager will re-eval this query on model changes
          // and emit surgical add/remove/update ops to this socket.
          const socketId = req._socketId;
          if (socketId && adapter.subscriptions) {
            const sub = await adapter.subscriptions.subscribe({
              socketId,
              query,
            });

            const items = [...sub.items];
            json(res, 200, {
              result: {
                total: items.length,
                __queryHash: sub.hash,
                [type + "s"]: items,
              },
              success: true,
            });
            return;
          }

          const items = await query.find();

          json(res, 200, {
            result: {
              total: items.length,
              [type + "s"]: await Promise.all(
                (items as any[]).map(
                  (m: any) => m.sanitize?.(ctx.user) ?? m.__data,
                ),
              ),
            },
            success: true,
          });
        } catch (err: any) {
          if (err instanceof ClientError) {
            json(res, err.status, {
              result: null,
              success: false,
              error: err.message,
            });
          } else {
            log.error(`[routes] GET ${path} error:`, err);
            json(res, 500, {
              result: null,
              success: false,
              error: "An error occurred while processing your request",
            });
          }
        }
      });
      count++;
    }

    // ── GET /path/:id — get one ────────────────────────────────────

    if (scope.read) {
      route.get(`${path}/:id`, async (req: any, res: any) => {
        try {
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
              (await (item as any).sanitize?.(ctx.user)) ??
              (item as any).__data,
            success: true,
          });
        } catch (err: any) {
          if (err instanceof ClientError) {
            json(res, err.status, {
              result: null,
              success: false,
              error: err.message,
            });
          } else {
            log.error(`[routes] GET ${path}/:id error:`, err);
            json(res, 500, {
              result: null,
              success: false,
              error: "An error occurred while processing your request",
            });
          }
        }
      });
      count++;
    }

    // ── POST /path — create ────────────────────────────────────────

    if (scope.create) {
      route.post(path, async (req: any, res: any) => {
        try {
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
        } catch (err: any) {
          if (err instanceof ClientError) {
            json(res, err.status, {
              result: null,
              success: false,
              error: err.message,
            });
          } else {
            log.error(`[routes] POST ${path} error:`, err);
            json(res, 500, {
              result: null,
              success: false,
              error: "An error occurred while processing your request",
            });
          }
        }
      });
      count++;
    }

    // ── PUT /path/:id — update ─────────────────────────────────────

    if (scope.update) {
      route.put(`${path}/:id`, async (req: any, res: any) => {
        try {
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
          const systemFields = new Set([
            "id",
            "createdAt",
            "updatedAt",
            "type",
          ]);
          for (const [key, value] of Object.entries(data)) {
            if (!systemFields.has(key)) {
              // Write through the proxy so change tracking picks it up
              (item as any)[key] = value;
            }
          }

          await (item as any).save(true);

          json(res, 200, {
            result:
              (await (item as any).sanitize?.(ctx.user)) ??
              (item as any).__data,
            success: true,
          });
        } catch (err: any) {
          if (err instanceof ClientError) {
            json(res, err.status, {
              result: null,
              success: false,
              error: err.message,
            });
          } else {
            log.error(`[routes] PUT ${path}/:id error:`, err);
            json(res, 500, {
              result: null,
              success: false,
              error: "An error occurred while processing your request",
            });
          }
        }
      });
      count++;
    }

    // ── DELETE /path/:id — delete ──────────────────────────────────

    if (scope.delete) {
      route.delete(`${path}/:id`, async (req: any, res: any) => {
        try {
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
        } catch (err: any) {
          if (err instanceof ClientError) {
            json(res, err.status, {
              result: null,
              success: false,
              error: err.message,
            });
          } else {
            log.error(`[routes] DELETE ${path}/:id error:`, err);
            json(res, 500, {
              result: null,
              success: false,
              error: "An error occurred while processing your request",
            });
          }
        }
      });
      count++;
    }

    // ── PATCH /path/:id — atomic JSON Patch ────────────────────────

    if (scope.patch || scope.update) {
      route.patch(`${path}/:id`, async (req: any, res: any) => {
        try {
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
              (await (item as any).sanitize?.(ctx.user)) ??
              (item as any).__data,
            success: true,
          });
        } catch (err: any) {
          if (err instanceof ClientError) {
            json(res, err.status, {
              result: null,
              success: false,
              error: err.message,
            });
          } else {
            log.error(`[routes] PATCH ${path}/:id error:`, err);
            json(res, 500, {
              result: null,
              success: false,
              error: "An error occurred while processing your request",
            });
          }
        }
      });
      count++;
    }
  }

  return count;
}
