import { log } from "./logger";
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
import { Model } from "@parcae/model";
import type { ModelConstructor, SchemaDefinition } from "@parcae/model";
import { generateSchemas } from "./schema/generate";
import { parseConfig } from "./config";
import type { Config } from "./config";
import { createServer_ } from "./server";
import type { ServerContext } from "./server";
import { getRoutes } from "./routing/route";
import { BackendAdapter } from "./adapters/model";
import { registerModelRoutes } from "./adapters/routes";
import { PubSub } from "./services/pubsub";
import { QueueService } from "./services/queue";
import { QuerySubscriptionManager } from "./services/subscriptions";
import { _setServices } from "./services/context";
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
      const writeDb = knex({
        client: "pg",
        connection: envConfig.DATABASE_URL,
        pool: { min: 2, max: 10 },
      });
      const readDb = envConfig.DATABASE_READ_URL
        ? knex({
            client: "pg",
            connection: envConfig.DATABASE_READ_URL,
            pool: { min: 2, max: 10 },
          })
        : writeDb;

      log.info("Database connected");

      // ── Step 4: Connect Redis (PubSub + Queue) ─────────────────────
      const pubsub = new PubSub({ url: envConfig.REDIS_URL });
      await pubsub.building;
      const queue = new QueueService({ url: envConfig.REDIS_URL });
      await queue.building;

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
      Model.use(adapter);

      // ── Step 6: Ensure tables (additive migration) ─────────────────
      if (process.env.ENSURE_SCHEMA === "true") {
        await adapter.ensureAllTables(models);
        log.info("Database schema ensured");
      }

      // ── Step 7: Create server ──────────────────────────────────────
      server = createServer_({ config: envConfig, version });

      // ── Step 8: Set up QuerySubscriptionManager ────────────────────
      const subscriptions = new QuerySubscriptionManager(
        adapter,
        (socketId, event, data) => {
          server?.io.to(socketId).emit(event, data);
        },
      );
      adapter.subscriptions = subscriptions;

      // ── Step 9: Set up auth (opt-in) ───────────────────────────────
      const authAdapter: AuthAdapter | null = config.auth ?? null;

      if (authAdapter) {
        // Find the User model (if registered)
        const userModel = models.find((m) => m.type === "user") ?? null;

        // Let the auth adapter set itself up (create tables, configure sync, etc.)
        await authAdapter.setup({
          userModel,
          adapter,
          config: envConfig,
          db: writeDb,
        });

        // Mount auth-specific routes (e.g. /v1/auth/* for Better Auth, /webhooks/clerk for Clerk)
        if (authAdapter.routes) {
          server.polka.all(
            `${authAdapter.routes.basePath}/*`,
            authAdapter.routes.handler,
          );
        }

        // Middleware: resolve every request to req.session
        server.polka.use(async (req: any, _res: any, next: any) => {
          try {
            req.session = await authAdapter!.resolveRequest(req);
          } catch {
            req.session = null;
          }
          next();
        });

        log.info("Auth enabled");
      }

      // ── Step 10: Register auto-CRUD routes ─────────────────────────
      const crudCount = registerModelRoutes(models, adapter, version);
      log.info(`Registered ${crudCount} auto-CRUD route(s)`);

      // ── Step 11: Auto-discover ──────────────────────────────────────
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

      // ── Step 12: Apply discovered routes to Polka ──────────────────
      const routes = getRoutes();
      for (const entry of routes) {
        const method = entry.method.toLowerCase() as keyof typeof server.polka;
        if (typeof server.polka[method] === "function") {
          const handlers = [...entry.middlewares, entry.handler];
          (server.polka[method] as any)(entry.path, ...handlers);
        }
      }

      // ── Step 13: Start job workers ─────────────────────────────────
      const registeredJobs = getJobs();
      if (registeredJobs.length > 0 && queue.get()) {
        const defaultQueue = queue.get()!;
        queue.createWorker(defaultQueue.name, async (bullJob) => {
          const jobEntry = registeredJobs.find((j) => j.name === bullJob.name);
          if (!jobEntry) {
            log.warn(`No handler for job "${bullJob.name}"`);
            return;
          }
          return jobEntry.handler({
            data: bullJob.data,
            bullJob,
            attempt: bullJob.attemptsMade,
          });
        });
      }

      // ── Step 14: Socket.IO connection handling ─────────────────────
      const modelsByType = new Map(models.map((m) => [m.type, m]));

      server.io.on("connection", (socket) => {
        // Authenticate via bearer token
        socket.on("authenticate", async (token: string, callback: any) => {
          if (authAdapter) {
            try {
              const session = await authAdapter.resolveToken(token);
              callback({ userId: session?.user?.id ?? null });
            } catch {
              callback({ userId: null });
            }
          } else {
            callback?.({ userId: null });
          }
        });

        // Query subscriptions
        socket.on("subscribe:query", async (data: any) => {
          const modelClass = modelsByType.get(data.modelType);
          if (!modelClass) return;
          const result = await subscriptions.subscribe({
            socketId: socket.id,
            modelClass,
            steps: data.steps ?? [],
            scopeFilter: data.scopeFilter ?? null,
          });
          socket.emit(`query:${data.hash}:init`, result.items);
        });

        socket.on("unsubscribe:query", (data: any) => {
          subscriptions.unsubscribe(socket.id, data.hash);
        });

        socket.on("disconnect", () => {
          subscriptions.unsubscribeAll(socket.id);
        });
      });

      // ── Step 15: Start listening ───────────────────────────────────
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
