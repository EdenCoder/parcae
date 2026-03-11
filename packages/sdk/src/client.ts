/**
 * @parcae/sdk — createClient()
 *
 * Auth is handled in the transport, not React.
 * Pass token at creation time, or call authenticate() later.
 */

import { Model, FrontendAdapter } from "@parcae/model";
import type { Transport, RequestOptions } from "@parcae/model";
import { SocketTransport } from "./transports/socket";
import { SSETransport } from "./transports/sse";

export interface ClientConfig {
  url: string;
  version?: string;
  transport?: "socket" | "sse" | Transport;
  /** Initial auth token. null = no auth. undefined = call authenticate() later. */
  token?: string | null;
}

export interface ParcaeClient {
  transport: Transport;
  get(path: string, data?: any, options?: RequestOptions): Promise<any>;
  post(path: string, data?: any, options?: RequestOptions): Promise<any>;
  put(path: string, data?: any, options?: RequestOptions): Promise<any>;
  patch(path: string, data?: any, options?: RequestOptions): Promise<any>;
  delete(path: string, data?: any, options?: RequestOptions): Promise<any>;
  subscribe(event: string, handler: (...args: any[]) => void): () => void;
  unsubscribe(event: string, handler?: (...args: any[]) => void): void;
  send(event: string, ...args: any[]): void;
  readonly isConnected: boolean;
  authenticate(token: string | null): Promise<{ userId: string | null }>;
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler?: (...args: any[]) => void): void;
  disconnect(): void;
  reconnect(): Promise<void>;
}

export function createClient(config: ClientConfig): ParcaeClient {
  // Idempotent — return existing client if already created for this url
  const cacheKey = `${config.url}:${config.version ?? "v1"}`;
  const existing = (globalThis as any).__parcae_clients?.get(cacheKey);
  if (existing) return existing;

  const version = config.version ?? "v1";

  let transport: any;

  if (config.transport && typeof config.transport === "object") {
    transport = config.transport;
  } else if (config.transport === "sse") {
    transport = new SSETransport({ url: config.url, version });
  } else {
    transport = new SocketTransport({
      url: config.url,
      version,
      token: config.token,
    });
  }

  Model.use(new FrontendAdapter(transport));

  const client: ParcaeClient = {
    transport,
    get: (p, d, o) => transport.get(p, d, o),
    post: (p, d, o) => transport.post(p, d, o),
    put: (p, d, o) => transport.put(p, d, o),
    patch: (p, d, o) => transport.patch(p, d, o),
    delete: (p, d, o) => transport.delete(p, d, o),
    subscribe: (e, h) => transport.subscribe?.(e, h) ?? (() => {}),
    unsubscribe: (e, h) => transport.unsubscribe?.(e, h),
    send: (e, ...a) => transport.send?.(e, ...a),
    get isConnected() {
      return transport.isConnected ?? false;
    },
    authenticate: (t) =>
      transport.authenticate?.(t) ?? Promise.resolve({ userId: null }),
    on: (e, h) => transport.on?.(e, h),
    off: (e, h) => transport.off?.(e, h),
    disconnect: () => transport.disconnect?.(),
    reconnect: () => transport.reconnect?.() ?? Promise.resolve(),
  };

  // Cache the client globally
  if (!(globalThis as any).__parcae_clients) {
    (globalThis as any).__parcae_clients = new Map();
  }
  (globalThis as any).__parcae_clients.set(cacheKey, client);

  return client;
}
