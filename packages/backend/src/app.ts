/**
 * @parcae/backend — createApp()
 *
 * The main entry point for a Parcae backend application.
 * Handles the full startup sequence: RTTIST typegen, database connection,
 * model registration, auto-CRUD routes, controller/hook/job discovery,
 * and HTTP + WebSocket server startup.
 */

import type { ModelConstructor } from "@parcae/model";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface AppConfig {
  /** Model classes or directory glob for auto-discovery. */
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
}

export interface ParcaeApp {
  /** Start the server. */
  start(options?: { dev?: boolean; port?: number }): Promise<void>;
  /** Stop the server. */
  stop(): Promise<void>;
}

// ─── createApp ───────────────────────────────────────────────────────────────

export function createApp(config: AppConfig): ParcaeApp {
  const version = config.version ?? "v1";

  return {
    async start(options = {}) {
      const port = options.port ?? parseInt(process.env.PORT ?? "3000", 10);
      const dev = options.dev ?? process.env.NODE_ENV === "development";

      console.log(`[parcae] Starting${dev ? " (dev mode)" : ""}...`);

      // TODO: M0 — Run RTTIST typegen → .parcae/
      // TODO: M2 — Connect database, register models, start server
      // TODO: M2 — Auto-discover controllers, hooks, jobs
      // TODO: M2 — Start HTTP + WebSocket on port ${port}

      console.log(`[parcae] Ready on port ${port}`);
    },

    async stop() {
      console.log("[parcae] Shutting down...");
      // TODO: Graceful shutdown
    },
  };
}
