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

  return {
    get schemas() {
      return schemas;
    },
    get models() {
      return models;
    },

    async start(options = {}) {
      const port = options.port ?? parseInt(process.env.PORT ?? "3000", 10);
      const dev = options.dev ?? process.env.NODE_ENV === "development";

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
        ? [] // No file paths to hash when models are passed directly
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

      // ── Step 6: Register auto-CRUD routes ──────────────────────────
      // TODO: DOL-151 — Auto-CRUD from model schemas

      // ── Step 7: Discover controllers, hooks, jobs ──────────────────
      // TODO: DOL-152 — Auto-discovery

      // ── Step 8: Start HTTP + WebSocket server ──────────────────────
      // TODO: DOL-149 continued — Polka + Socket.IO

      console.log(`[parcae] Ready on port ${port} (v${version})`);
    },

    async stop() {
      console.log("[parcae] Shutting down...");
      // TODO: Graceful shutdown
    },
  };
}
