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
import { getJobs } from "./routing/job";
import {
  createAuth,
  createAuthMiddleware,
  createSocketAuthHandler,
} from "./auth";
import type { AuthConfig } from "./auth";
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
  /** Authentication configuration. Opt-in — omit to skip auth entirely. */
  auth?: AuthConfig;
  /** API version prefix. Default: "v1" */
  version?: string;
  /** Project root directory. Default: process.cwd() */
  root?: string;
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
    console.warn(`[parcae] Models directory not found: ${absDir}`);
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
      console.warn(
        `[parcae] Failed to import model from ${entry}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return models;
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
      envConfig = parseConfig(process.env);
      const port = options.port ?? envConfig.PORT;
      const dev = options.dev ?? envConfig.NODE_ENV === "development";

      console.log(`[parcae] Starting${dev ? " (dev mode)" : ""}...`);

      // ── Step 1: Discover models ────────────────────────────────────
      if (Array.isArray(config.models)) {
        models = config.models;
      } else {
        models = await discoverModels(config.models);
      }
      console.log(
        `[parcae] Found ${models.length} model(s): ${models.map((m) => m.type).join(", ")}`,
      );

      // ── Step 2: Generate schemas (.parcae/) ────────────────────────
      const modelPaths = Array.isArray(config.models)
        ? []
        : [resolve(config.models)];

      const result = await generateSchemas(models, {
        projectRoot,
        modelPaths,
        force: false,
        dev,
      });
      schemas = result.schemas;

      console.log(
        `[parcae] Resolved schemas for: ${[...schemas.keys()].join(", ")}` +
          (result.regenerated ? " (regenerated)" : " (cached)"),
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

      console.log("[parcae] Database connected");

      // ── Step 4: Connect Redis (PubSub + Queue) ─────────────────────
      const pubsub = new PubSub({ url: envConfig.REDIS_URL });
      await pubsub.building;
      const queue = new QueueService({ url: envConfig.REDIS_URL });
      await queue.building;

      if (envConfig.REDIS_URL) {
        console.log("[parcae] Redis connected (PubSub + Queue)");
      } else {
        console.log(
          "[parcae] Redis not configured — using in-process fallbacks",
        );
      }

      // ── Step 5: Set up BackendAdapter + Model.use() ────────────────
      const adapter = new BackendAdapter({
        read: readDb,
        write: writeDb,
        pubsub,
      });
      Model.use(adapter);

      // ── Step 6: Ensure tables (additive migration) ─────────────────
      await adapter.ensureAllTables(models);
      console.log("[parcae] Database schema ensured");

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

      // ── Step 8b: Set up auth (opt-in) ─────────────────────────────
      let authInstance: ReturnType<typeof createAuth> | null = null;
      let socketAuthHandler: ReturnType<typeof createSocketAuthHandler> | null =
        null;

      if (config.auth) {
        authInstance = createAuth(config.auth, envConfig);
        const authMiddleware = createAuthMiddleware(authInstance);
        socketAuthHandler = createSocketAuthHandler(authInstance);

        // Mount auth middleware on all requests (resolves req.session)
        server.polka.use(authMiddleware);

        // Mount Better Auth handler for /v1/auth/* routes
        const authBasePath = config.auth.basePath ?? "/v1/auth";
        server.polka.all(`${authBasePath}/*`, async (req: any, res: any) => {
          // Forward to Better Auth
          const response = await authInstance!.handler(req);
          // Better Auth returns a Response object — pipe it through
          if (response && typeof response.status === "number") {
            res.writeHead(
              response.status,
              Object.fromEntries(response.headers.entries()),
            );
            const body = await response.text();
            res.end(body);
          }
        });

        console.log(
          `[parcae] Auth enabled (${config.auth.providers?.join(", ") ?? "email"})`,
        );
      }

      // ── Step 9: Register auto-CRUD routes ──────────────────────────
      const crudCount = registerModelRoutes(models, adapter, version);
      console.log(`[parcae] Registered ${crudCount} auto-CRUD route(s)`);

      // ── Step 10: Register custom routes, hooks, jobs ───────────────
      const routes = getRoutes();
      for (const entry of routes) {
        const method = entry.method.toLowerCase() as keyof typeof server.polka;
        if (typeof server.polka[method] === "function") {
          const handlers = [...entry.middlewares, entry.handler];
          (server.polka[method] as any)(entry.path, ...handlers);
        }
      }
      console.log(`[parcae] Registered ${routes.length} custom route(s)`);

      // ── Step 11: Start job workers ─────────────────────────────────
      const registeredJobs = getJobs();
      if (registeredJobs.length > 0 && queue.get()) {
        const defaultQueue = queue.get()!;
        queue.createWorker(defaultQueue.name, async (bullJob) => {
          const jobEntry = registeredJobs.find((j) => j.name === bullJob.name);
          if (!jobEntry) {
            console.warn(`[parcae] No handler for job "${bullJob.name}"`);
            return;
          }
          return jobEntry.handler({
            data: bullJob.data,
            bullJob,
            attempt: bullJob.attemptsMade,
          });
        });
        console.log(
          `[parcae] Started worker for ${registeredJobs.length} job(s)`,
        );
      }

      // ── Step 12: Socket.IO connection handling ─────────────────────
      // Model class lookup for subscription requests
      const modelsByType = new Map(models.map((m) => [m.type, m]));

      server.io.on("connection", (socket) => {
        let socketSession: any = null;

        // Authenticate via bearer token
        socket.on("authenticate", async (token: string, callback: any) => {
          if (socketAuthHandler) {
            socketSession = await socketAuthHandler(token, callback);
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

      // ── Step 13: Start listening ───────────────────────────────────
      await new Promise<void>((resolveStart) => {
        server!.httpServer.listen(port, () => resolveStart());
      });

      console.log(`[parcae] Ready on port ${port} (v${version})`);
    },

    async stop() {
      console.log("[parcae] Shutting down...");
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
