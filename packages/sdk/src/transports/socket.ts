/**
 * SocketTransport — Socket.IO with separated session/connection state.
 *
 * The transport owns three orthogonal concerns:
 *   - the underlying socket (Socket.IO)
 *   - the ConnectionMachine (is the wire usable?)
 *   - the SessionMachine (who is the user?)
 *
 * Wire protocol:
 *   client → server:  "hello" + { token } → ack({ userId })
 *   client → server:  "call" (RPC, unchanged)
 *   client → server:  "resync" + { queries: [...] } → ack(results)
 *   server → client:  "query:<hash>" ops streams (unchanged)
 *
 * Lifecycle invariants:
 *   - socket connect runs `hello` exactly once per connection
 *   - disconnect does NOT touch session state
 *   - reconnect emits a single `resync` event after `hello` resolves
 *   - session changes propagate through SessionMachine.resolve only
 */

import SocketIO from "socket.io-client";
import pako from "pako";
import { decompress } from "compress-json";
import { EventEmitter } from "eventemitter3";
import ShortId from "short-unique-id";
import type { Transport, RequestOptions } from "@parcae/model";
import { SessionMachine } from "../session-machine";
import { ConnectionMachine } from "../connection-machine";
import { log } from "../log";

const DEFAULT_TIMEOUT = 120_000;

const uid = new ShortId({ length: 10 });
const SOCKETS = new Map<string, any>();

/** @internal — test-only. Clears the cached socket map between tests. */
export function _resetSockets(): void {
  for (const socket of SOCKETS.values()) {
    try {
      socket.removeAllListeners?.();
    } catch {}
  }
  SOCKETS.clear();
}

export interface SocketTransportConfig {
  url: string;
  version?: string;
  path?: string;
  /**
   * Async token resolver. Called once before the initial connect and
   * once on every reconnect (handing back the latest token from the
   * auth adapter). Return `null` for anonymous sessions.
   */
  getToken: () => Promise<string | null>;
  /**
   * socket.io transports list. Defaults to `["websocket"]` — the
   * fast path used by web, Node, and any runtime with a WebSocket
   * global. Pass `["polling"]` (or `["polling", "websocket"]`) for
   * runtimes that don't expose `WebSocket` natively (e.g. Lynx
   * PrimJS in a custom native shell without LynxWebSocketModule).
   */
  transports?: ("websocket" | "polling")[];
  /**
   * Extra headers attached to the socket handshake (the WebSocket
   * upgrade / polling requests). Applied in Node and React Native;
   * browsers cannot set custom WebSocket headers and silently
   * ignore these. The server sees them on
   * `socket.handshake.headers`, and the backend's socket RPC bridge
   * spreads handshake headers onto every synthetic request, so a
   * header set here reaches middleware like any per-request header.
   */
  extraHeaders?: Record<string, string>;
}

/** Wire shape for a single `resync` entry. */
export interface ResyncEntry {
  key: string;
  modelType: string;
  steps: unknown[];
  /** Last-known queryHash, so the server can skip resending unchanged subscriptions. */
  queryHash?: string | null;
  /**
   * `false` when the matching `useQuery` was mounted with
   * `{ subscribe: false }`. The server's resync handler takes the
   * static path for these entries — fresh fetch, no subscription
   * registered, `hash: null` in the result. Absence ⇒ subscribed
   * (legacy behaviour), so older backends remain compatible.
   */
  subscribe?: boolean;
}

/** Wire shape for a single resolved entry coming back from the server. */
export interface ResyncResult {
  key: string;
  /**
   * `null` for static (`subscribe: false`) entries — no subscription
   * was registered server-side, so there's no hash to attach a
   * `query:${hash}` listener to. The SDK uses this to short-circuit
   * the subscribe block in `_onResyncRequired`.
   */
  hash: string | null;
  items: any[];
  totalCount: number;
}

export class SocketTransport extends EventEmitter implements Transport {
  public session = new SessionMachine();
  public connection = new ConnectionMachine();

  private socket: any;
  private url: string;
  private version: string;
  private getToken: () => Promise<string | null>;
  private inflight = new Map<string, Promise<any>>();
  /** Resolves when the most recent `hello` ack lands. */
  private helloReady: Promise<void> = Promise.resolve();

  constructor(config: SocketTransportConfig) {
    super();
    this.url = config.url;
    this.version = config.version ?? "v1";
    this.getToken = config.getToken;

    const socketPath = config.path ?? "/ws";
    const transports = config.transports ?? ["websocket"];
    const extraHeaders = config.extraHeaders;
    // Headers are part of the pool key: two transports to the same URL
    // with different headers must not share a handshake.
    const socketKey =
      `${this.url}:${socketPath}:${transports.join(",")}` +
      (extraHeaders ? `:${JSON.stringify(extraHeaders)}` : "");

    if (SOCKETS.has(socketKey)) {
      this.socket = SOCKETS.get(socketKey);
    } else {
      this.socket = SocketIO(this.url, {
        path: socketPath,
        transports,
        withCredentials: true,
        ...(extraHeaders ? { extraHeaders } : {}),
      });
      SOCKETS.set(socketKey, this.socket);
    }

    this.connection.connecting();

    this.socket.on("connect", () => {
      this.connection.connected();
      this.emit("connected");
      void this._handshake().catch(() => {});
    });

    this.socket.on("disconnect", () => {
      // Critical: disconnect does NOT touch session.
      // Session is identity; identity outlives any single socket.
      this.connection.disconnected();
      this.emit("disconnected");
    });

    this.socket.on("error", (err: Error) => {
      this.connection.disconnected(err);
      this.emit("error", err);
    });

    if (this.socket.connected) {
      this.connection.connected();
      void this._handshake().catch(() => {});
    }
  }

  // ── Hello / resync handshake ─────────────────────────────────────

  private async _handshake(): Promise<void> {
    let resolveHello!: () => void;
    this.helloReady = new Promise<void>((r) => {
      resolveHello = r;
    });

    let token: string | null = null;
    try {
      token = await this.getToken();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.warn(`hello: token resolution failed (${error.message})`);
      this.emit("error", error);
      // Keep SessionMachine pending / unchanged. A failed token read is
      // not proof of an anonymous session; it usually means the auth
      // endpoint is temporarily unavailable (502/CORS during backend
      // restart). Treating it as null would fire protected queries as
      // :anon: and turn transient infra failure into 403 storms.
      throw error;
    }

    const t0 = performance.now();
    return new Promise<void>((resolve) => {
      this.socket.emit("hello", { token }, (response: any) => {
        const ms = (performance.now() - t0).toFixed(0);
        const userId = response?.userId ?? null;
        log.debug(
          `hello: ${userId ? `userId=${userId}` : "anonymous"} (${ms}ms)`,
        );
        this.session.resolve(userId);
        resolveHello();
        // Resync runs after every successful hello. Consumers track
        // their own cache state and decide whether they have anything
        // to ask the server about; the transport just publishes the
        // signal once per handshake.
        this.emit("resync-required");
        resolve();
      });
    });
  }

  /**
   * Resync RPC. Used by `useQuery` after every reconnect to
   * re-establish server-side query subscriptions in a single round
   * trip. Returns the freshly-evaluated results for every entry.
   */
  async resync(entries: ResyncEntry[]): Promise<ResyncResult[]> {
    if (entries.length === 0) return [];
    await this.helloReady;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("resync timeout"));
      }, DEFAULT_TIMEOUT);
      this.socket.emit("resync", { queries: entries }, (response: any) => {
        clearTimeout(timeout);
        if (response?.success === false) {
          reject(new Error(response?.error || "resync failed"));
          return;
        }
        resolve(response?.results ?? []);
      });
    });
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Token rotation / explicit sign-in. Triggers a fresh hello on the
   * existing socket so the server updates its socket→session mapping.
   * Sign-out path (token === null) goes through `terminate()`.
   *
   * If the session was previously terminated (sign-out), this resets
   * the machine back to "pending" before handshaking. That covers the
   * sign-out → sign-in-again flow in long-lived single-page apps where
   * the same SDK client is reused across multiple user identities.
   */
  async refreshSession(): Promise<{ userId: string | null }> {
    if (this.session.state.status === "terminated") {
      this.session.reset();
    }
    await this._handshake();
    return { userId: this.session.state.userId };
  }

  /** Explicit sign-out. Marks the session terminated and drops the socket auth. */
  async terminateSession(): Promise<void> {
    this.session.terminate();
    if (this.socket.connected) {
      await new Promise<void>((resolve) => {
        this.socket.emit("hello", { token: null }, () => resolve());
      });
    }
  }

  get isConnected(): boolean {
    return this.connection.state.status === "connected";
  }

  // ── Request/Response ─────────────────────────────────────────────

  private async fetch(
    method: string,
    path: string,
    data: any = {},
    options?: RequestOptions,
  ): Promise<any> {
    // Wait for the first hello to land — guarantees the socket is
    // authenticated before the call goes out. Subsequent calls don't
    // re-await because `helloReady` resolves once and stays resolved
    // until the next reconnect kicks a new handshake.
    await this.helloReady;

    if (!this.socket.connected) {
      await new Promise<void>((resolve, reject) => {
        if (this.socket.connected) return resolve();
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Connection timeout"));
        }, DEFAULT_TIMEOUT);
        const onConnect = () => {
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          clearTimeout(timeout);
          this.socket.off("connect", onConnect);
          this.socket.off("connect_error", onError);
        };
        this.socket.once("connect", onConnect);
        this.socket.once("connect_error", onError);
      });
      await this.helloReady;
    }

    const upper = method.toUpperCase();
    if (upper === "GET") {
      const dedupeKey = `${path}:${JSON.stringify(data)}`;
      const existing = this.inflight.get(dedupeKey);
      if (existing) return existing;
      const req = this._call(method, path, data, options);
      this.inflight.set(dedupeKey, req);
      req.then(
        () => this.inflight.delete(dedupeKey),
        () => this.inflight.delete(dedupeKey),
      );
      return req;
    }

    return this._call(method, path, data, options);
  }

  private _call(
    method: string,
    path: string,
    data: any,
    options?: RequestOptions,
  ): Promise<any> {
    const id = uid.rnd();
    const t0 = performance.now();
    const fullPath = `/${this.version}${path}`;
    const timeoutMs = options?.timeout ?? DEFAULT_TIMEOUT;
    log.debug(`→ ${method.toUpperCase()} ${fullPath}`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.socket.off(id);
        log.debug(
          `✗ ${method.toUpperCase()} ${fullPath} timeout (${(timeoutMs / 1000).toFixed(0)}s)`,
        );
        reject(new Error(`RPC timeout: ${method} ${path}`));
      }, timeoutMs);

      this.socket.once(id, (msg: any) => {
        clearTimeout(timeout);
        const ms = (performance.now() - t0).toFixed(0);
        try {
          const uncompressed = pako.ungzip(msg, { to: "string" });
          const parsed = decompress(JSON.parse(uncompressed));
          if (parsed.success) {
            log.debug(`← ${method.toUpperCase()} ${fullPath} (${ms}ms)`);
            resolve(parsed.result);
          } else {
            log.debug(
              `✗ ${method.toUpperCase()} ${fullPath} (${ms}ms) ${parsed.error || parsed.message}`,
            );
            reject(
              new Error(
                parsed.message || parsed.error || `${method} ${path} failed`,
              ),
            );
          }
        } catch (err) {
          log.debug(
            `✗ ${method.toUpperCase()} ${fullPath} (${ms}ms) parse error`,
          );
          reject(err);
        }
      });

      this.socket.emit(
        "call",
        id,
        method.toUpperCase(),
        `/${this.version}${path}`,
        data,
      );
    });
  }

  async get(path: string, data?: any, options?: RequestOptions): Promise<any> {
    return this.fetch("GET", path, data, options);
  }
  async post(path: string, data?: any, options?: RequestOptions): Promise<any> {
    return this.fetch("POST", path, data, options);
  }
  async put(path: string, data?: any, options?: RequestOptions): Promise<any> {
    return this.fetch("PUT", path, data, options);
  }
  async patch(
    path: string,
    data?: any,
    options?: RequestOptions,
  ): Promise<any> {
    return this.fetch("PATCH", path, data, options);
  }
  async delete(
    path: string,
    data?: any,
    options?: RequestOptions,
  ): Promise<any> {
    return this.fetch("DELETE", path, data, options);
  }

  subscribe(event: string, handler: (...args: any[]) => void): () => void {
    this.socket.on(event, handler);
    return () => this.socket.off(event, handler);
  }

  unsubscribe(event: string, handler?: (...args: any[]) => void): void {
    this.socket.off(event, handler);
  }

  send(event: string, ...args: any[]): void {
    this.socket.emit(event, ...args);
  }

  disconnect(): void {
    this.socket.disconnect();
  }

  async reconnect(): Promise<void> {
    if (this.socket.connected) return;
    this.connection.connecting();
    this.socket.connect();
  }
}
