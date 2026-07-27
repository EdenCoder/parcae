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
   * A cached `url:version` client can only be reused with the exact
   * same transports and header values; incompatible reuse fails closed.
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
  /** @internal Whether a newly supplied token resolver still needs a hello. */
  readonly needsSessionRefresh?: boolean;
  /** @internal Replace the token resolver when a cached client is reused. */
  updateTokenResolver?(getToken: ClientConfig["getToken"]): void;
  /** @internal Whether an active Provider owns resolver mutation. */
  readonly hasTokenResolverLease?: boolean;
  /** @internal Bind resolver ownership to a committed Provider instance. */
  acquireTokenResolverLease?(
    lease: object,
    getToken: ClientConfig["getToken"],
  ): void;
  /** @internal Release resolver ownership when that Provider unmounts. */
  releaseTokenResolverLease?(lease: object): boolean;
  /** Re-run the hello handshake on the current socket. */
  refreshSession(): Promise<{ userId: string | null }>;
  /** @internal Wait until the current auth source is server-confirmed. */
  awaitSessionReconciled?(): Promise<{ userId: string | null }>;
  /** Explicit sign-out — terminates the session machine. */
  terminateSession(): Promise<void>;
  /** Server resync RPC — batched query subscription restore. */
  resync(entries: ResyncEntry[]): Promise<ResyncResult[]>;
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler?: (...args: any[]) => void): void;
  disconnect(): void;
  reconnect(): Promise<void>;
}

interface ConnectionConfigSnapshot {
  transports: readonly ("websocket" | "polling")[];
  headers: Readonly<Record<string, string>>;
}

const connectionConfigs = new WeakMap<ParcaeClient, ConnectionConfigSnapshot>();
const modelAdapters = new WeakMap<ParcaeClient, FrontendAdapter>();

/** @internal Test support for verifying collision-resistant cache identity. */
export function _clientCacheKeyForTest(url: string, version = "v1"): string {
  return JSON.stringify([url, version]);
}

function snapshotConnectionConfig(
  config: ClientConfig,
): ConnectionConfigSnapshot {
  return {
    transports: Object.freeze([...(config.transports ?? ["websocket"])]),
    headers: Object.freeze({ ...(config.extraHeaders ?? {}) }),
  };
}

function connectionConfigsEqual(
  left: ConnectionConfigSnapshot,
  right: ConnectionConfigSnapshot,
): boolean {
  if (left.transports.length !== right.transports.length) return false;
  for (let index = 0; index < left.transports.length; index++) {
    if (left.transports[index] !== right.transports[index]) return false;
  }

  const leftHeaders = Object.keys(left.headers).sort();
  const rightHeaders = Object.keys(right.headers).sort();
  if (leftHeaders.length !== rightHeaders.length) return false;
  for (let index = 0; index < leftHeaders.length; index++) {
    const key = leftHeaders[index]!;
    if (
      key !== rightHeaders[index] ||
      left.headers[key] !== right.headers[key]
    ) {
      return false;
    }
  }
  return true;
}

/** @internal Test support for simulating an already-cached client. */
export function _rememberConnectionConfigForTest(
  client: ParcaeClient,
  config: ClientConfig,
): void {
  connectionConfigs.set(client, snapshotConnectionConfig(config));
}

function getOrCreateClient(
  config: ClientConfig,
  reconcileCachedResolver: boolean,
): ParcaeClient {
  const cacheKey = _clientCacheKeyForTest(config.url, config.version ?? "v1");
  const requestedConnectionConfig = snapshotConnectionConfig(config);
  const clients: Map<string, ParcaeClient> | undefined = (globalThis as any)
    .__parcae_clients;
  const legacyCacheKey = `${config.url}:${config.version ?? "v1"}`;
  if (clients?.has(legacyCacheKey)) {
    // Pre-structured-key builds can leave an authenticated socket in the
    // realm under an ambiguous concatenated key. Never create a second client
    // beside it; a full reload is the only safe upgrade boundary.
    throw new Error(
      "Legacy cached Parcae client detected; reload required before creating a client",
    );
  }
  const existing = clients?.get(cacheKey);
  if (existing) {
    const existingConnectionConfig = connectionConfigs.get(existing);
    if (!existingConnectionConfig) {
      throw new Error(
        "Cached Parcae client belongs to a different SDK module instance or older build; reload required",
      );
    }
    if (
      !connectionConfigsEqual(
        existingConnectionConfig,
        requestedConnectionConfig,
      )
    ) {
      throw new Error(
        "Cached Parcae client has incompatible transports or extraHeaders; create a separate client URL/version or reload",
      );
    }
    if (!reconcileCachedResolver) return existing;

    if (existing.hasTokenResolverLease) {
      throw new Error(
        "Cached Parcae client is owned by an active Provider; use withIsolatedClient for one-shot work",
      );
    }

    if (typeof existing.updateTokenResolver === "function") {
      existing.updateTokenResolver(config.getToken);
      return existing;
    }

    // A hot-reloaded realm can retain a client made by an older SDK build.
    // Its physical socket can still own old listeners, so neither reuse nor
    // replacement is safe inside this realm. Fail closed until a full reload.
    throw new Error(
      "Cached Parcae client cannot reconcile a new auth source; reload required",
    );
  }

  if (clients && clients.size > 0) {
    throw new Error(
      "Parcae supports one primary Model client per realm; use createIsolatedClient for a different URL or version",
    );
  }

  return createClientInstance(
    config,
    cacheKey,
    true,
    requestedConnectionConfig,
  );
}

function createClientInstance(
  config: ClientConfig,
  cacheKey: string | null,
  installModelAdapter: boolean,
  connectionConfig = snapshotConnectionConfig(config),
): ParcaeClient {
  const transport = new SocketTransport({
    url: config.url,
    version: config.version ?? "v1",
    getToken: config.getToken,
    transports: [...connectionConfig.transports],
    extraHeaders: { ...connectionConfig.headers },
  });
  const modelAdapter = new FrontendAdapter(transport);

  if (installModelAdapter) {
    Model.use(modelAdapter);
  }

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
    get needsSessionRefresh() {
      return transport.needsSessionRefresh;
    },
    updateTokenResolver: (getToken) => transport.updateTokenResolver(getToken),
    get hasTokenResolverLease() {
      return transport.hasTokenResolverLease;
    },
    acquireTokenResolverLease: (lease, getToken) =>
      transport.acquireTokenResolverLease(lease, getToken),
    releaseTokenResolverLease: (lease) =>
      transport.releaseTokenResolverLease(lease),
    refreshSession: () => transport.refreshSession(),
    awaitSessionReconciled: () => transport.awaitSessionReconciled(),
    terminateSession: () => transport.terminateSession(),
    resync: (entries) => transport.resync(entries),
    on: (e, h) => transport.on(e, h),
    off: (e, h) => transport.off(e, h),
    disconnect: () => transport.disconnect(),
    reconnect: () => transport.reconnect(),
  };
  connectionConfigs.set(client, connectionConfig);
  modelAdapters.set(client, modelAdapter);
  let lastResolvedOwner = transport.session.state.userId;
  transport.session.subscribe(() => {
    const { status, userId } = transport.session.state;
    if (
      status === "pending" ||
      status === "terminated" ||
      userId !== lastResolvedOwner
    ) {
      Model.clearRefCache(modelAdapter);
    }
    if (status !== "pending") lastResolvedOwner = userId;
  });

  if (cacheKey !== null) {
    if (!(globalThis as any).__parcae_clients) {
      (globalThis as any).__parcae_clients = new Map();
    }
    (globalThis as any).__parcae_clients.set(cacheKey, client);
  }

  return client;
}

export function createClient(config: ClientConfig): ParcaeClient {
  return getOrCreateClient(config, true);
}

/**
 * Create a client with its own physical socket and no global client cache.
 * Call `disconnect()` when the isolated operation or lifecycle completes.
 */
export function createIsolatedClient(config: ClientConfig): ParcaeClient {
  return createClientInstance(config, null, false);
}

/**
 * Run one isolated operation and always close its physical socket afterward.
 */
export async function withIsolatedClient<T>(
  config: ClientConfig,
  operation: (client: ParcaeClient) => Promise<T>,
): Promise<T> {
  const client = createIsolatedClient(config);
  try {
    return await operation(client);
  } finally {
    client.disconnect();
  }
}

/**
 * Resolve the Provider's client without mutating a cached client's auth source
 * during React render. The Provider binds the resolver after commit.
 *
 * @internal
 */
export function _getOrCreateProviderClient(config: ClientConfig): ParcaeClient {
  return getOrCreateClient(config, false);
}

/**
 * Resolve the model adapter that belongs to this client's physical transport.
 * Returns `null` only for foreign/test doubles not created by this SDK module.
 *
 * @internal
 */
export function _getClientModelAdapter(
  client: ParcaeClient,
): FrontendAdapter | null {
  return modelAdapters.get(client) ?? null;
}
