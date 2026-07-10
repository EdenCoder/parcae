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
  /** Maximum time to wait for a hello acknowledgement. */
  handshakeTimeout?: number;
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

interface PendingWaiter {
  cleanup: () => void;
  reject: (error: Error) => void;
}

export class SocketTransport extends EventEmitter implements Transport {
  public session = new SessionMachine();
  public connection = new ConnectionMachine();

  private socket: any;
  private url: string;
  private version: string;
  private getToken: () => Promise<string | null>;
  private inflight = new Map<string, Promise<any>>();
  private pendingCalls = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void }
  >();
  private pendingWaiters = new Set<PendingWaiter>();
  private handshakeTimeout: number;
  private sessionGeneration = 0;
  private activeHandshake: {
    generation: number;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private isDisposed = false;
  private helloGeneration = -1;
  private helloState: "idle" | "pending" | "resolved" | "rejected" = "idle";
  /** Settles when the most recent `hello` attempt settles. */
  private helloReady: Promise<void> = Promise.resolve();

  constructor(config: SocketTransportConfig) {
    super();
    this.url = config.url;
    this.version = config.version ?? "v1";
    this.getToken = config.getToken;
    this.handshakeTimeout = config.handshakeTimeout ?? DEFAULT_TIMEOUT;

    const socketPath = config.path ?? "/ws";
    const transports = config.transports ?? ["websocket"];
    const extraHeaders = config.extraHeaders;
    this.socket = SocketIO(this.url, {
      path: socketPath,
      transports,
      withCredentials: true,
      ...(extraHeaders ? { extraHeaders } : {}),
    });

    this.connection.connecting();

    this.socket.on("connect", () => {
      if (this.isDisposed) return;
      this.connection.connected();
      this.emit("connected");
      void this._handshake().catch(() => {});
    });

    this.socket.on("disconnect", (reason?: string) => {
      // Critical: disconnect does NOT touch session.
      // Session is identity; identity outlives any single socket.
      this._handleSocketDisconnect(reason);
    });

    this.socket.on("connect_error", (err: Error) => {
      this._advanceGeneration(err);
      this.connection.disconnected(err);
      this.emit("error", err);
    });

    this.socket.on("error", (err: Error) => {
      this.emit("error", err);
    });

    if (this.socket.connected) {
      this.connection.connected();
      void this._handshake().catch(() => {});
    }
  }

  // ── Hello / resync handshake ─────────────────────────────────────

  private _handshake(fresh = false): Promise<void> {
    if (this.isDisposed) return Promise.reject(new Error("Transport disposed"));
    if (!this.socket.connected) {
      return Promise.reject(new Error("Cannot handshake while disconnected"));
    }

    if (
      !fresh &&
      this.helloGeneration === this.sessionGeneration &&
      (this.helloState === "pending" || this.helloState === "resolved")
    ) {
      return this.helloReady;
    }
    if (fresh) this._advanceGeneration(new Error("Hello superseded"));
    const generation = this.sessionGeneration;
    this.helloGeneration = generation;
    this.helloState = "pending";
    this.inflight.clear();

    let resolveHello!: () => void;
    let rejectHello!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveHello = resolve;
      rejectHello = reject;
    });
    // Fetch callers still receive the rejection; this handler only
    // prevents an unobserved reconnect handshake from becoming global.
    void ready.catch(() => {});
    this.helloReady = ready;
    this.activeHandshake = {
      generation,
      reject: rejectHello,
      timer: null,
    };
    this.activeHandshake.timer = setTimeout(() => {
      this._rejectHandshake(generation, new Error("Hello timeout"));
    }, this.handshakeTimeout);

    void this.getToken().then(
      (token) => {
        const active = this.activeHandshake;
        if (!active || active.generation !== generation) return;
        if (!this.socket.connected) {
          this._rejectHandshake(
            generation,
            new Error("Disconnected before hello"),
          );
          return;
        }

        const t0 = performance.now();
        this.socket.emit("hello", { token }, (response: any) => {
          const current = this.activeHandshake;
          if (!current || current.generation !== generation) return;
          if (!response || response.success === false) {
            this._rejectHandshake(
              generation,
              new Error(
                response?.error ||
                  response?.message ||
                  "Missing hello acknowledgement",
              ),
            );
            return;
          }

          if (current.timer) clearTimeout(current.timer);
          this.activeHandshake = null;
          this.helloState = "resolved";
          const userId = response.userId ?? null;
          const ms = (performance.now() - t0).toFixed(0);
          log.debug(
            `hello: ${userId ? `userId=${userId}` : "anonymous"} (${ms}ms)`,
          );
          this.session.resolve(userId);
          resolveHello();
          this.emit("resync-required");
        });
      },
      (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log.warn(`hello: token resolution failed (${error.message})`);
        this._rejectHandshake(generation, error);
      },
    );

    return ready;
  }

  private _rejectHandshake(generation: number, error: Error): void {
    const active = this.activeHandshake;
    if (!active || active.generation !== generation) return;
    if (active.timer) clearTimeout(active.timer);
    this.activeHandshake = null;
    this.helloState = "rejected";
    active.reject(error);
    this.emit("error", error);
  }

  private _advanceGeneration(error: Error): void {
    this.sessionGeneration++;
    this.inflight.clear();
    this.helloState = "rejected";
    this._rejectPending(error);
    const active = this.activeHandshake;
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    this.activeHandshake = null;
    active.reject(error);
  }

  private _handleSocketDisconnect(reason?: string): void {
    if (this.connection.state.status === "disconnected") return;
    this._advanceGeneration(
      new Error(reason ? `Disconnected: ${reason}` : "Disconnected"),
    );
    this.connection.disconnected();
    this.emit("disconnected");
  }

  private _trackWaiter(
    reject: (error: Error) => void,
    cleanup: () => void,
  ): () => void {
    const waiter = { reject, cleanup };
    this.pendingWaiters.add(waiter);
    return () => {
      if (!this.pendingWaiters.delete(waiter)) return;
      cleanup();
    };
  }

  private _rejectPending(error: Error): void {
    for (const [id, call] of this.pendingCalls) {
      clearTimeout(call.timer);
      this.socket.off(id);
      call.reject(error);
    }
    this.pendingCalls.clear();
    for (const waiter of [...this.pendingWaiters]) {
      this.pendingWaiters.delete(waiter);
      waiter.cleanup();
      waiter.reject(error);
    }
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
      let settled = false;
      let release = () => {};
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        release();
        reject(error);
      };
      const timeout = setTimeout(() => {
        fail(new Error("resync timeout"));
      }, DEFAULT_TIMEOUT);
      release = this._trackWaiter(fail, () => clearTimeout(timeout));
      this.socket.emit("resync", { queries: entries }, (response: any) => {
        if (settled) return;
        settled = true;
        release();
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
    await this._handshake(true);
    return { userId: this.session.state.userId };
  }

  /** Explicit sign-out. Marks the session terminated and drops the socket auth. */
  async terminateSession(): Promise<void> {
    this.session.terminate();
    this._advanceGeneration(new Error("Session terminated"));
    if (this.socket.connected) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let release = () => {};
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          release();
          reject(error);
        };
        const timeout = setTimeout(() => {
          fail(new Error("Session termination timeout"));
        }, this.handshakeTimeout);
        release = this._trackWaiter(fail, () => clearTimeout(timeout));
        this.socket.emit("hello", { token: null }, (response: any) => {
          if (settled) return;
          settled = true;
          release();
          if (!response || response.success === false) {
            reject(
              new Error(
                response?.error ||
                  response?.message ||
                  "Missing session termination acknowledgement",
              ),
            );
            return;
          }
          resolve();
        });
      });
    }
  }

  get isConnected(): boolean {
    return this.connection.state.status === "connected";
  }

  private _assertCanRequest(): void {
    if (this.isDisposed) throw new Error("Transport disposed");
    if (this.session.state.status === "terminated") {
      throw new Error("Session terminated");
    }
  }

  private _waitForConnection(): Promise<void> {
    if (this.socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let release = () => {};
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        release();
        reject(error);
      };
      const timeout = setTimeout(() => {
        fail(new Error("Connection timeout"));
      }, DEFAULT_TIMEOUT);
      const onConnect = () => {
        if (settled) return;
        settled = true;
        release();
        resolve();
      };
      const onError = (error: Error) => fail(error);
      const cleanup = () => {
        clearTimeout(timeout);
        this.socket.off("connect", onConnect);
        this.socket.off("connect_error", onError);
      };
      release = this._trackWaiter(fail, cleanup);
      this.socket.once("connect", onConnect);
      this.socket.once("connect_error", onError);
    });
  }

  // ── Request/Response ─────────────────────────────────────────────

  private async fetch(
    method: string,
    path: string,
    data: any = {},
    options?: RequestOptions,
  ): Promise<any> {
    this._assertCanRequest();

    // Wait for the first hello to land — guarantees the socket is
    // authenticated before the call goes out. Subsequent calls don't
    // re-await because `helloReady` resolves once and stays resolved
    // until the next reconnect kicks a new handshake.
    await this.helloReady;

    if (!this.socket.connected) {
      await this._waitForConnection();
      await this.helloReady;
    }

    this._assertCanRequest();

    const upper = method.toUpperCase();
    if (upper === "GET") {
      const dedupeKey = `${this.sessionGeneration}:${path}:${JSON.stringify(data)}`;
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
        this.pendingCalls.delete(id);
        log.debug(
          `✗ ${method.toUpperCase()} ${fullPath} timeout (${(timeoutMs / 1000).toFixed(0)}s)`,
        );
        reject(new Error(`RPC timeout: ${method} ${path}`));
      }, timeoutMs);
      this.pendingCalls.set(id, { timer: timeout, reject });

      this.socket.once(id, (msg: any) => {
        clearTimeout(timeout);
        this.pendingCalls.delete(id);
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
            const details =
              parsed.error && typeof parsed.error === "object"
                ? parsed.error
                : parsed;
            const error = Object.assign(
              new Error(
                details.message ||
                  (typeof parsed.error === "string" ? parsed.error : null) ||
                  parsed.message ||
                `${method} ${path} failed`,
              ),
              {
                ...(typeof (details.status ?? parsed.status) === "number"
                  ? { status: details.status ?? parsed.status }
                  : {}),
                ...(typeof (details.code ?? parsed.code) === "string"
                  ? { code: details.code ?? parsed.code }
                  : {}),
              },
            );
            reject(error);
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
    if (!this.socket.connected) this._handleSocketDisconnect();
    this.socket.disconnect();
  }

  async reconnect(): Promise<void> {
    if (this.isDisposed) throw new Error("Transport disposed");
    if (this.socket.connected) {
      if (this.helloState === "rejected" || this.helloState === "idle") {
        await this._handshake(true);
      } else {
        await this.helloReady;
      }
      return;
    }

    this.connection.connecting();
    const connected = this._waitForConnection();
    this.socket.connect();
    await connected;
    await this.helloReady;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this._advanceGeneration(new Error("Transport disposed"));
    this.emit("dispose");
    this.socket.removeAllListeners?.();
    this.socket.disconnect();
    this.inflight.clear();
    this.removeAllListeners();
    this.connection.disconnected();
  }
}
