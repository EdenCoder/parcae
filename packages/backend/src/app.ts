/**
 * @parcae/backend — createApp()
 *
 * The main entry point for a Parcae backend application.
 * Handles the full startup sequence: .parcae/ generation, database connection,
 * model registration, auto-CRUD routes, controller/hook/job discovery,
 * and HTTP + WebSocket server startup.
 */

import { resolve, join } from "node:path";
import { readdirSync, existsSync, statSync } from "node:fs";
import pako from "pako";
import { compress } from "compress-json";
import { Model } from "@parcae/model";
import type { ModelConstructor, SchemaDefinition } from "@parcae/model";
import { log } from "./logger";
import { ClientError } from "./helpers";
import { generateSchemas } from "./schema/generate";
import { parseConfig, isSqliteUrl, sqliteFilename } from "./config";
import type { Config } from "./config";
import { createServer_ } from "./server";
import type { ServerContext } from "./server";
import {
  getRoutes,
  getSocketHandlers,
  runSocketChain,
  type SocketContext,
} from "./routing/route";
import { BackendAdapter } from "./adapters/model";
import { registerModelRoutes } from "./adapters/routes";
import { PubSub } from "./services/pubsub";
import { QueueService } from "./services/queue";
import { QuerySubscriptionManager } from "./services/subscriptions";
import { _setServices, _setIo } from "./services/context";
import { getJobs } from "./routing/job";
import { getHooks } from "./routing/hook";
import type { AuthAdapter } from "./auth";
import knex from "knex";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface AppConfig {
  /** Model classes or directory path for auto-discovery. */
  models: ModelConstructor[] | string;
  /** Controllers directory for auto-discovery. */
  controllers?: string;
  /** Hooks directory for auto-discovery. */
  hooks?: string;
  /** Jobs directory for auto-discovery. */
  jobs?: string;
  /** Authentication adapter. Opt-in — omit to skip auth entirely. */
  auth?: AuthAdapter;
  /** API version prefix. Default: "v1" */
  version?: string;
  /** Project root directory. Default: process.cwd() */
  root?: string;
  /**
   * Path to the models package (where reflect.config.json lives).
   * Used by RTTIST for type generation. Can be absolute or relative to root.
   * If not set, auto-detected from common monorepo locations.
   */
  modelsPath?: string;
}

export interface ParcaeApp {
  /** Start the server. */
  start(options?: { dev?: boolean; port?: number }): Promise<void>;
  /** Stop the server gracefully. */
  stop(): Promise<void>;
  /** Resolved model schemas. Available after start(). */
  schemas: Map<string, SchemaDefinition>;
  /** Loaded model constructors. Available after start(). */
  models: ModelConstructor[];
}

// ─── Model discovery ─────────────────────────────────────────────────────────

/**
 * Auto-discover model classes from a directory.
 * Imports all .ts/.js files and extracts default exports that have `static type`.
 */
async function discoverModels(dir: string): Promise<ModelConstructor[]> {
  const absDir = resolve(dir);
  if (!existsSync(absDir)) {
    log.warn(`Models directory not found: ${absDir}`);
    return [];
  }

  const models: ModelConstructor[] = [];
  const entries = readdirSync(absDir);

  for (const entry of entries) {
    if (!entry.endsWith(".ts") && !entry.endsWith(".js")) continue;
    if (entry.startsWith(".") || entry.startsWith("_")) continue;

    const filePath = join(absDir, entry);
    const stat = statSync(filePath);
    if (!stat.isFile()) continue;

    try {
      const mod = await import(filePath);
      // Check all exports for Model constructors
      for (const exported of Object.values(mod)) {
        if (
          typeof exported === "function" &&
          (exported as any).type &&
          typeof (exported as any).type === "string"
        ) {
          models.push(exported as ModelConstructor);
        }
      }
    } catch (err) {
      log.warn(
        `Failed to import model from ${entry}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return models;
}

// ─── Auto-discovery ──────────────────────────────────────────────────────────

/**
 * Auto-discover and import all .ts/.js files from a directory (recursively).
 * Files self-register by calling route.*, hook.*, job() at import time.
 * Like Next.js — just put files in the directory, they're auto-loaded.
 */
async function discoverAndImport(dir: string, label: string): Promise<number> {
  const absDir = resolve(dir);
  if (!existsSync(absDir)) return 0;

  let count = 0;
  const entries = readdirSync(absDir, { recursive: true });

  for (const entry of entries) {
    const entryStr = entry.toString();
    if (!entryStr.endsWith(".ts") && !entryStr.endsWith(".js")) continue;
    if (entryStr.startsWith(".") || entryStr.startsWith("_")) continue;
    if (entryStr.includes("node_modules")) continue;
    if (entryStr === "index.ts" || entryStr === "index.js") continue;

    const filePath = join(absDir, entryStr);
    const stat = statSync(filePath);
    if (!stat.isFile()) continue;

    try {
      await import(filePath);
      count++;
    } catch (err) {
      log.warn(
        `Failed to import ${label} from ${entryStr}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return count;
}

// ─── createApp ───────────────────────────────────────────────────────────────

export function createApp(config: AppConfig): ParcaeApp {
  const version = config.version ?? "v1";
  const projectRoot = resolve(config.root ?? process.cwd());

  let schemas = new Map<string, SchemaDefinition>();
  let models: ModelConstructor[] = [];
  let server: ServerContext | null = null;
  let envConfig: Config | null = null;

  return {
    get schemas() {
      return schemas;
    },
    get models() {
      return models;
    },

    async start(options = {}) {
      // ── Step 0: Parse & validate config ────────────────────────────
      envConfig = parseConfig(process.env, projectRoot);
      const port = options.port ?? envConfig.PORT;
      const dev = options.dev ?? envConfig.NODE_ENV === "development";

      log.info(`Starting${dev ? " (dev mode)" : ""}...`);

      // ── Step 1: Discover models ────────────────────────────────────
      if (Array.isArray(config.models)) {
        models = config.models;
      } else {
        models = await discoverModels(config.models);
      }
      log.info(
        `Found ${models.length} model(s): ${models.map((m) => m.type).join(", ")}`,
      );

      // ── Step 2: Generate schemas (.parcae/) ────────────────────────
      const result = await generateSchemas(models, {
        projectRoot,
        modelsPath: config.modelsPath,
        force: false,
        dev,
      });
      schemas = result.schemas;

      log.info(
        `Resolved schemas for: ${[...schemas.keys()].join(", ")}` +
          (result.cached ? " (cached)" : " (resolved)"),
      );

      // ── Step 3: Connect database ───────────────────────────────────
      const useSqlite = isSqliteUrl(envConfig.DATABASE_URL);

      let writeDb: ReturnType<typeof knex>;
      let readDb: ReturnType<typeof knex>;

      if (useSqlite) {
        const filename = sqliteFilename(envConfig.DATABASE_URL);
        writeDb = knex({
          client: "better-sqlite3",
          connection: { filename },
          useNullAsDefault: true,
        });
        readDb = writeDb; // SQLite has no read replica
        log.info(`SQLite database: ${filename}`);
      } else {
        writeDb = knex({
          client: "pg",
          connection: envConfig.DATABASE_URL,
          pool: { min: 2, max: 10 },
        });
        readDb = envConfig.DATABASE_READ_URL
          ? knex({
              client: "pg",
              connection: envConfig.DATABASE_READ_URL,
              pool: { min: 2, max: 10 },
            })
          : writeDb;
      }

      log.info("Database connected");

      // ── Step 4: Connect Redis (PubSub + Queue) ─────────────────────
      log.info("Connecting PubSub...");
      const pubsub = new PubSub({ url: envConfig.REDIS_URL });
      await pubsub.building;
      log.info("PubSub ready");

      log.info("Connecting Queue...");
      const queue = new QueueService({ url: envConfig.REDIS_URL });
      await queue.building;
      log.info("Queue ready");

      // Make queue + pubsub available globally via enqueue() and lock()
      _setServices(queue, pubsub);

      if (envConfig.REDIS_URL) {
        log.info("Redis connected (PubSub + Queue)");
      } else {
        log.info("Redis not configured — using in-process fallbacks");
      }

      // ── Step 5: Set up BackendAdapter + Model.use() ────────────────
      const adapter = new BackendAdapter({
        read: readDb,
        write: writeDb,
        pubsub,
      });
      adapter.registerModels(models);
      Model.use(adapter);

      // Detect database engine (SQLite / Postgres / AlloyDB)
      log.info("Detecting database engine...");
      await adapter.detectEngine(useSqlite ? "sqlite" : undefined);
      log.info("Database engine detected");

      // ── Step 6: Set up auth (opt-in) ───────────────────────────────
      // Auth runs BEFORE ensureAllTables so that auth-owned tables
      // (users, sessions, accounts, verifications) are created first.
      // Parcae's ensureAllTables then adds any custom columns to the
      // users table and creates app-specific tables.
      const authAdapter: AuthAdapter | null = config.auth ?? null;
      const ensureSchema = process.env.ENSURE_SCHEMA === "true";

      if (authAdapter) {
        const userModel = models.find((m) => m.type === "user") ?? null;

        await authAdapter.setup({
          userModel,
          adapter,
          config: envConfig,
          db: writeDb,
          ensureSchema,
        });

        log.info("Auth enabled");
      }

      // ── Step 7: Ensure tables (additive migration) ─────────────────
      if (ensureSchema) {
        await adapter.ensureAllTables(models);
        log.info("Database schema ensured");
      }

      // ── Step 8: Create server ──────────────────────────────────────
      server = createServer_({ config: envConfig, version });
      _setIo(server.io);

      // ── Step 9: Set up QuerySubscriptionManager ────────────────────
      const subscriptions = new QuerySubscriptionManager(
        (socketId, event, data) => {
          server?.io.to(socketId).emit(event, data);
        },
      );
      adapter.subscriptions = subscriptions;

      // ── Step 10: Mount auth routes + middleware ─────────────────────
      if (authAdapter) {
        if (authAdapter.routes) {
          server.polka.all(
            `${authAdapter.routes.basePath}/*`,
            authAdapter.routes.handler,
          );
        }

        // Middleware: resolve every request to req.session
        server.polka.use(async (req: any, _res: any, next: any) => {
          // Skip for socket RPC calls — session already injected
          if (req._socketRpc) return next();
          try {
            req.session = await authAdapter!.resolveRequest(req);
          } catch {
            req.session = null;
          }
          next();
        });
      }

      // ── Step 11: Default routes ────────────────────────────────────
      server.polka.get(`/${version}/health`, (_req: any, res: any) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            uptime: process.uptime(),
            models: models.length,
            version,
          }),
        );
      });

      // ── Step 12: Register auto-CRUD routes ─────────────────────────
      const crudCount = registerModelRoutes(models, adapter, version);
      log.info(`Registered ${crudCount} auto-CRUD route(s)`);

      // ── Step 13: Auto-discover ──────────────────────────────────────
      // Scan all configured directories. Files self-register by calling
      // route.*, hook.*, job() at import time. Doesn't matter which dir
      // a hook or job lives in — just that the file exists.
      const routesBefore = getRoutes().length;
      const hooksBefore = getHooks().length;
      const jobsBefore = getJobs().length;

      const dirs = [config.controllers, config.hooks, config.jobs].filter(
        (d): d is string => typeof d === "string",
      );
      let totalFiles = 0;
      for (const dir of dirs) {
        totalFiles += await discoverAndImport(dir, "module");
      }

      const routesAfter = getRoutes().length;
      const hooksAfter = getHooks().length;
      const jobsAfter = getJobs().length;

      log.info(
        `Discovered ${totalFiles} file(s) → ` +
          `${routesAfter - routesBefore} route(s), ` +
          `${hooksAfter - hooksBefore} hook(s), ` +
          `${jobsAfter - jobsBefore} job(s)`,
      );

      // ── Step 14: Apply discovered routes to Polka ──────────────────
      const routes = getRoutes();
      for (const entry of routes) {
        const method = entry.method.toLowerCase() as keyof typeof server.polka;
        if (typeof server.polka[method] === "function") {
          const handlers = [...entry.middlewares, entry.handler];
          (server.polka[method] as any)(entry.path, ...handlers);
        }
      }

      // ── Step 15: Start job workers ─────────────────────────────────
      const registeredJobs = getJobs();
      if (registeredJobs.length > 0 && queue.get()) {
        const defaultQueue = queue.get()!;
        const maxConcurrency = Math.max(
          1,
          ...registeredJobs.map((j) => j.options?.concurrency ?? 1),
        );
        queue.createWorker(
          defaultQueue.name,
          async (bullJob) => {
            const jobEntry = registeredJobs.find(
              (j) => j.name === bullJob.name,
            );
            if (!jobEntry) {
              log.warn(`No handler for job "${bullJob.name}"`);
              return;
            }
            return jobEntry.handler({
              data: bullJob.data,
              bullJob,
              attempt: bullJob.attemptsMade,
            });
          },
          maxConcurrency,
        );
      }

      // ── Step 16: Socket.IO connection handling ─────────────────────
      const modelsByType = new Map(models.map((m) => [m.type, m]));

      server.io.on("connection", (socket) => {
        let socketSession: any = null;

        // ── RPC: pipe socket calls through Polka's HTTP handler ─────
        socket.on(
          "call",
          async (
            requestId: string,
            method: string,
            path: string,
            data: any,
          ) => {
            try {
              // Parse query string from path
              const [pathname, qs] = path.split("?");
              const query: Record<string, any> = {};
              if (qs) {
                for (const pair of qs.split("&")) {
                  const [k, v] = pair.split("=");
                  if (k)
                    query[decodeURIComponent(k)] = v
                      ? decodeURIComponent(v)
                      : "";
                }
              }

              // Merge URL query params with socket data for GET requests
              const mergedQuery =
                method.toUpperCase() === "GET" ? { ...query, ...data } : query;

              // Build fake req that Polka's handler can process.
              // NOTE: Polka's handler unconditionally overwrites req.query
              // with querystring.parse(info.query), which destroys complex
              // objects (like __query arrays). We stash the real query in
              // _socketQuery so middleware can restore it.
              const fakeReq: any = {
                method: method.toUpperCase(),
                url: path,
                headers: {
                  ...socket.handshake.headers,
                  "content-type": "application/json",
                },
                body: data,
                query: mergedQuery,
                _socketQuery: mergedQuery,
                params: {},
                session: socketSession,
                _socketRpc: true, // marker: skip auth middleware resolution
                _socketId: socket.id,
                _parsedUrl: { pathname, query: qs || "", _raw: path },
              };

              // Build fake res that captures the response
              let responseBody: any = null;
              const fakeRes: any = {
                statusCode: 200,
                writeHead(code: number, headers?: any) {
                  this.statusCode = code;
                  return this;
                },
                setHeader() {
                  return this;
                },
                end(body?: string) {
                  if (body) {
                    try {
                      responseBody = JSON.parse(body);
                    } catch {
                      responseBody = body;
                    }
                  }
                  // Send compressed response
                  const compressed = pako.gzip(
                    JSON.stringify(
                      compress(responseBody ?? { result: null, success: true }),
                    ),
                  );
                  socket.emit(requestId, compressed);
                },
              };

              // Run through Polka's full handler (includes middleware, auth, auto-CRUD, custom routes)
              (server!.polka as any).handler(fakeReq, fakeRes);
            } catch (err: any) {
              log.error(`[socket] RPC error:`, err);
              const compressed = pako.gzip(
                JSON.stringify(
                  compress({
                    result: null,
                    success: false,
                    error:
                      err instanceof ClientError
                        ? err.message
                        : "An error occurred while processing your request",
                  }),
                ),
              );
              socket.emit(requestId, compressed);
            }
          },
        );

        // Authenticate via bearer token
        socket.on("authenticate", async (token: string, callback: any) => {
          if (authAdapter) {
            try {
              socketSession = await authAdapter.resolveToken(token);
              callback({ userId: socketSession?.user?.id ?? null });
            } catch {
              callback({ userId: null });
            }
          } else {
            callback?.({ userId: null });
          }
        });

        // ── route.on() — custom Socket.IO event handlers ──────────
        const socketHandlers = getSocketHandlers();
        for (const entry of socketHandlers) {
          socket.on(entry.event, async (data: any) => {
            const ctx: SocketContext = {
              socket,
              io: server!.io,
              data,
              session: socketSession,
              socketId: socket.id,
              emit: (event: string, ...args: any[]) =>
                socket.emit(event, ...args),
            };
            try {
              await runSocketChain(entry.middlewares, entry.handler, ctx);
            } catch (err: any) {
              log.error(`[socket] ${entry.event} error:`, err);
              socket.emit("error", {
                event: entry.event,
                message:
                  err instanceof ClientError
                    ? err.message
                    : "An error occurred",
              });
            }
          });
        }

        // Query subscriptions
        socket.on("unsubscribe:query", (data: any) => {
          subscriptions.unsubscribe(socket.id, data.hash);
        });

        socket.on("disconnect", () => {
          subscriptions.unsubscribeAll(socket.id);
        });
      });

      // ── Step 17: Start listening ───────────────────────────────────
      await new Promise<void>((resolveStart) => {
        server!.httpServer.listen(port, () => resolveStart());
      });

      log.success(
        `Ready on port ${port} — ` +
          `${models.length} models, ` +
          `${routes.length + crudCount} routes, ` +
          `${getHooks().length} hooks, ` +
          `${getJobs().length} jobs`,
      );
    },

    async stop() {
      log.info("Shutting down...");
      if (server) {
        server.io.close();
        await new Promise<void>((resolveClose) => {
          server!.httpServer.close(() => resolveClose());
        });
        server = null;
      }
    },
  };
}
