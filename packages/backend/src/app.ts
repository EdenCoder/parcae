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
import type { ModelConstructor, SchemaDefinition } from "@parcae/model";
import { generateSchemas } from "./schema/generate";
import { parseConfig } from "./config";
import type { Config } from "./config";
import { createServer_ } from "./server";
import type { ServerContext } from "./server";
import { getRoutes } from "./routing/route";

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
  /** Authentication configuration. */
  auth?: {
    providers?: ("email" | "google" | "github")[];
    [key: string]: any;
  };
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
      // TODO: DOL-150 — Knex connection, read/write replicas

      // ── Step 4: Set up BackendAdapter + Model.use() ────────────────
      // TODO: DOL-150 — BackendAdapter

      // ── Step 5: Ensure tables ──────────────────────────────────────
      // TODO: DOL-150 — Additive migration from schemas

      // ── Step 6: Create server ──────────────────────────────────────
      server = createServer_({ config: envConfig, version });

      // ── Step 7: Register auto-CRUD routes ──────────────────────────
      // TODO: DOL-151 — Auto-CRUD from model schemas

      // ── Step 8: Discover & register custom routes, hooks, jobs ─────
      // Auto-discovered controllers/hooks/jobs are loaded and registered
      // at import time via their respective register functions.
      // Here we apply them to the Polka instance.
      const routes = getRoutes();
      for (const entry of routes) {
        const method = entry.method.toLowerCase() as keyof typeof server.polka;
        if (typeof server.polka[method] === "function") {
          const handlers = [...entry.middlewares, entry.handler];
          (server.polka[method] as any)(entry.path, ...handlers);
        }
      }

      console.log(`[parcae] Registered ${routes.length} custom route(s)`);

      // ── Step 9: Socket.IO connection handling ──────────────────────
      server.io.on("connection", (socket) => {
        // TODO: DOL-150 — Auth, subscribe:query, call events
        console.log(`[parcae] Client connected: ${socket.id}`);

        socket.on("disconnect", () => {
          // TODO: Cleanup subscriptions
        });
      });

      // ── Step 10: Start listening ───────────────────────────────────
      await new Promise<void>((resolveStart) => {
        server!.httpServer.listen(port, () => {
          resolveStart();
        });
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
