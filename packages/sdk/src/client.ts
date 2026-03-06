/**
 * @parcae/sdk — createClient()
 *
 * Creates a Parcae client with a pluggable transport.
 * Authentication is driven by the consumer (Provider) via client.authenticate().
 */

import { Model, FrontendAdapter } from "@parcae/model";
import type { Transport } from "@parcae/model";
import { SocketTransport } from "./transports/socket";
import { SSETransport } from "./transports/sse";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface ClientConfig {
  url: string;
  version?: string;
  transport?: "socket" | "sse" | Transport;
}

export interface ParcaeClient {
  transport: Transport;
  get(path: string, data?: any): Promise<any>;
  post(path: string, data?: any): Promise<any>;
  put(path: string, data?: any): Promise<any>;
  patch(path: string, data?: any): Promise<any>;
  delete(path: string, data?: any): Promise<any>;
  subscribe(event: string, handler: (...args: any[]) => void): () => void;
  unsubscribe(event: string, handler?: (...args: any[]) => void): void;
  send(event: string, ...args: any[]): void;
  readonly isConnected: boolean;

  /** Authenticate with the backend. Resolves when auth is confirmed. */
  authenticate(token: string | null): Promise<{ userId: string | null }>;

  /** Listen for transport events: connected, disconnected, reconnected, error */
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler?: (...args: any[]) => void): void;

  disconnect(): void;
  reconnect(): Promise<void>;
}

// ─── createClient ────────────────────────────────────────────────────────────

export function createClient(config: ClientConfig): ParcaeClient {
  const version = config.version ?? "v1";

  let transport: any;

  if (config.transport && typeof config.transport === "object") {
    transport = config.transport;
  } else if (config.transport === "sse") {
    transport = new SSETransport({ url: config.url, version });
  } else {
    transport = new SocketTransport({ url: config.url, version });
  }

  // Wire FrontendAdapter so Model.where() etc work
  Model.use(new FrontendAdapter(transport));

  const client: ParcaeClient = {
    transport,

    get: (path, data) => transport.get(path, data),
    post: (path, data) => transport.post(path, data),
    put: (path, data) => transport.put(path, data),
    patch: (path, data) => transport.patch(path, data),
    delete: (path, data) => transport.delete(path, data),

    subscribe(event, handler) {
      if (transport.subscribe) return transport.subscribe(event, handler);
      return () => {};
    },
    unsubscribe(event, handler) {
      transport.unsubscribe?.(event, handler);
    },
    send(event, ...args) {
      transport.send?.(event, ...args);
    },

    get isConnected() {
      return transport.isConnected ?? false;
    },

    async authenticate(token: string | null) {
      if (typeof transport.authenticate === "function") {
        return transport.authenticate(token);
      }
      // SSE/custom transports: resolve immediately
      return { userId: null };
    },

    on(event, handler) {
      transport.on?.(event, handler);
    },
    off(event, handler) {
      transport.off?.(event, handler);
    },

    disconnect() {
      transport.disconnect?.();
    },
    async reconnect() {
      await transport.reconnect?.();
    },
  };

  return client;
}
