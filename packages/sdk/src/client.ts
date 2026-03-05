/**
 * @parcae/sdk — createClient()
 *
 * The Socket.IO-based client for connecting to a Parcae backend.
 * Handles connection management, authentication, request deduplication,
 * and gzip compression.
 */

import { Model, FrontendAdapter } from "@parcae/model";
import type { Transport } from "@parcae/model";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface ClientConfig {
  /** URL of the Parcae backend. */
  url: string;
  /** API key — string or async function that returns a key. */
  key?: string | (() => Promise<string>);
  /** API version prefix. Default: "v1" */
  version?: string;
}

export interface ParcaeClient extends Transport {
  /** Whether the client is currently connected. */
  isConnected: boolean;
  /** Whether the client is currently loading (connecting/authenticating). */
  isLoading: boolean;
  /** Promise that resolves when the client is ready. */
  loading: Promise<void>;
  /** Disconnect from the server. */
  disconnect(): void;
  /** Reconnect to the server. */
  reconnect(): Promise<void>;
}

// ─── createClient ────────────────────────────────────────────────────────────

export function createClient(config: ClientConfig): ParcaeClient {
  const version = config.version ?? "v1";

  // TODO: M3 — Socket.IO connection setup
  // TODO: M3 — Auth flow (key resolution, authenticate event)
  // TODO: M3 — gzip compression (pako) + compress-json
  // TODO: M3 — Request deduplication

  const client: ParcaeClient = {
    isConnected: false,
    isLoading: true,
    loading: Promise.resolve(),

    async get(path: string, _data?: any) {
      throw new Error(`[parcae/sdk] Not yet connected — GET ${path}`);
    },
    async post(path: string, _data?: any) {
      throw new Error(`[parcae/sdk] Not yet connected — POST ${path}`);
    },
    async put(path: string, _data?: any) {
      throw new Error(`[parcae/sdk] Not yet connected — PUT ${path}`);
    },
    async patch(path: string, _data?: any) {
      throw new Error(`[parcae/sdk] Not yet connected — PATCH ${path}`);
    },
    async delete(path: string, _data?: any) {
      throw new Error(`[parcae/sdk] Not yet connected — DELETE ${path}`);
    },
    disconnect() {},
    async reconnect() {},
  };

  // Set up FrontendAdapter so Model.where() etc. work
  Model.use(new FrontendAdapter(client));

  return client;
}
