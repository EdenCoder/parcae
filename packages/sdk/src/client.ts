/**
 * @parcae/sdk — createClient()
 *
 * Sessions live in the transport. The auth adapter is the source of
 * truth for tokens; the transport handles handshake + reconnect via
 * the hello/resync protocol. See `transports/socket.ts` for the
 * wire contract.
 */

import { Model, FrontendAdapter } from "@parcae/model";
import type { Transport, RequestOptions } from "@parcae/model";
import { SocketTransport } from "./transports/socket";
import type { ResyncEntry, ResyncResult } from "./transports/socket";
import type { SessionMachine } from "./session-machine";
import type { ConnectionMachine } from "./connection-machine";

export interface ClientConfig {
  url: string;
  version?: string;
  /**
   * Token resolver — called once before the initial hello and once
   * per reconnect. Return `null` for anonymous sessions.
   */
  getToken: () => Promise<string | null>;
  /**
   * socket.io transports list. Defaults to `["websocket"]`. Pass
   * `["polling"]` on runtimes without a WebSocket global (e.g. Lynx
   * PrimJS in a custom native shell).
   */
  transports?: ("websocket" | "polling")[];
  /**
   * Extra headers attached to the socket handshake. Applied in Node
   * and React Native; browsers ignore them for WebSocket transport.
   * Pass a stable reference. Note the client cache is keyed on
   * `url:version` only, so the first-created client's headers win
   * for that key (existing behaviour for all config).
   */
  extraHeaders?: Record<string, string>;
}

export interface ParcaeClient {
  transport: Transport;
  session: SessionMachine;
  connection: ConnectionMachine;
  get(path: string, data?: any, options?: RequestOptions): Promise<any>;
  post(path: string, data?: any, options?: RequestOptions): Promise<any>;
  put(path: string, data?: any, options?: RequestOptions): Promise<any>;
  patch(path: string, data?: any, options?: RequestOptions): Promise<any>;
  delete(path: string, data?: any, options?: RequestOptions): Promise<any>;
  subscribe(event: string, handler: (...args: any[]) => void): () => void;
  unsubscribe(event: string, handler?: (...args: any[]) => void): void;
  send(event: string, ...args: any[]): void;
  readonly isConnected: boolean;
  /** Re-run the hello handshake on the current socket. */
  refreshSession(): Promise<{ userId: string | null }>;
  /** Explicit sign-out — terminates the session machine. */
  terminateSession(): Promise<void>;
  /** Server resync RPC — batched query subscription restore. */
  resync(entries: ResyncEntry[]): Promise<ResyncResult[]>;
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler?: (...args: any[]) => void): void;
  disconnect(): void;
  reconnect(): Promise<void>;
}

export function createClient(config: ClientConfig): ParcaeClient {
  const cacheKey = `${config.url}:${config.version ?? "v1"}`;
  const existing = (globalThis as any).__parcae_clients?.get(cacheKey);
  if (existing) return existing;

  const transport = new SocketTransport({
    url: config.url,
    version: config.version ?? "v1",
    getToken: config.getToken,
    transports: config.transports,
    extraHeaders: config.extraHeaders,
  });

  Model.use(new FrontendAdapter(transport));

  const client: ParcaeClient = {
    transport,
    session: transport.session,
    connection: transport.connection,
    get: (p, d, o) => transport.get(p, d, o),
    post: (p, d, o) => transport.post(p, d, o),
    put: (p, d, o) => transport.put(p, d, o),
    patch: (p, d, o) => transport.patch(p, d, o),
    delete: (p, d, o) => transport.delete(p, d, o),
    subscribe: (e, h) => transport.subscribe(e, h),
    unsubscribe: (e, h) => transport.unsubscribe(e, h),
    send: (e, ...a) => transport.send(e, ...a),
    get isConnected() {
      return transport.isConnected;
    },
    refreshSession: () => transport.refreshSession(),
    terminateSession: () => transport.terminateSession(),
    resync: (entries) => transport.resync(entries),
    on: (e, h) => transport.on(e, h),
    off: (e, h) => transport.off(e, h),
    disconnect: () => transport.disconnect(),
    reconnect: () => transport.reconnect(),
  };

  if (!(globalThis as any).__parcae_clients) {
    (globalThis as any).__parcae_clients = new Map();
  }
  (globalThis as any).__parcae_clients.set(cacheKey, client);

  return client;
}
