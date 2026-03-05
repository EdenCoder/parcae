/**
 * @parcae/sdk — createClient()
 *
 * Creates a Parcae client with a pluggable transport layer.
 * Default: Socket.IO (bidirectional, realtime).
 * Alternative: SSE (HTTP + Server-Sent Events, simpler).
 *
 * The transport is abstracted — the client exposes the same API
 * regardless of which transport is used underneath.
 */

import { Model, FrontendAdapter } from "@parcae/model";
import type { Transport } from "@parcae/model";
import { SocketTransport } from "./transports/socket";
import type { SocketTransportConfig } from "./transports/socket";
import { SSETransport } from "./transports/sse";
import type { SSETransportConfig } from "./transports/sse";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface ClientConfig {
  /** URL of the Parcae backend. */
  url: string;
  /** API key — string or async function that returns a key. */
  key?: string | null | (() => Promise<string | null>);
  /** API version prefix. Default: "v1" */
  version?: string;
  /**
   * Transport type. Default: "socket"
   * - "socket": Socket.IO (bidirectional, realtime subscriptions)
   * - "sse": HTTP + Server-Sent Events (read-heavy, simpler infra)
   * - Transport instance: provide your own Transport implementation
   */
  transport?: "socket" | "sse" | Transport;
}

export interface ParcaeClient {
  /** The underlying transport instance. */
  transport: Transport;
  /** Shorthand for transport methods. */
  get(path: string, data?: any): Promise<any>;
  post(path: string, data?: any): Promise<any>;
  put(path: string, data?: any): Promise<any>;
  patch(path: string, data?: any): Promise<any>;
  delete(path: string, data?: any): Promise<any>;
  /** Subscribe to a named event. Returns dispose function. */
  subscribe(event: string, handler: (...args: any[]) => void): () => void;
  /** Unsubscribe from a named event. */
  unsubscribe(event: string, handler?: (...args: any[]) => void): void;
  /** Send a control message. */
  send(event: string, ...args: any[]): void;
  /** Connection state. */
  readonly isConnected: boolean;
  readonly isLoading: boolean;
  /** Promise that resolves when the client is ready. */
  loading: Promise<void>;
  /** Update the auth key. */
  setKey(key: string | null | (() => Promise<string | null>)): Promise<void>;
  /** Listen for transport events. */
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler?: (...args: any[]) => void): void;
  /** Disconnect from the server. */
  disconnect(): void;
  /** Reconnect. */
  reconnect(): Promise<void>;
  /** Auth version — incremented on auth changes. Useful for cache invalidation. */
  readonly authVersion: number;
}

// ─── createClient ────────────────────────────────────────────────────────────

export function createClient(config: ClientConfig): ParcaeClient {
  const version = config.version ?? "v1";

  // Create the transport
  let transport: Transport & {
    loading?: Promise<void>;
    isLoading?: boolean;
    isConnected?: boolean;
    authVersion?: number;
    setKey?: (key: any) => Promise<void>;
    on?: (event: string, handler: (...args: any[]) => void) => void;
    off?: (event: string, handler?: (...args: any[]) => void) => void;
    disconnect?: () => void;
    reconnect?: () => Promise<void>;
  };

  if (config.transport && typeof config.transport === "object") {
    // Custom transport instance
    transport = config.transport as any;
  } else if (config.transport === "sse") {
    transport = new SSETransport({
      url: config.url,
      key: config.key,
      version,
    });
  } else {
    // Default: Socket.IO
    transport = new SocketTransport({
      url: config.url,
      key: config.key,
      version,
    });
  }

  // Wire up FrontendAdapter so Model.where(), .findById() etc work
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
      return () => {}; // no-op if transport doesn't support subscriptions
    },

    unsubscribe(event, handler) {
      transport.unsubscribe?.(event, handler);
    },

    send(event, ...args) {
      (transport as any).send?.(event, ...args);
    },

    get isConnected() {
      return transport.isConnected ?? false;
    },
    get isLoading() {
      return transport.isLoading ?? false;
    },
    get loading() {
      return (transport as any).loading ?? Promise.resolve();
    },
    get authVersion() {
      return (transport as any).authVersion ?? 0;
    },

    async setKey(key) {
      if ((transport as any).setKey) await (transport as any).setKey(key);
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
