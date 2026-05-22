/**
 * SocketTransport — Socket.IO with Valtio-reactive AuthGate.
 *
 * Auth state lives in a Valtio proxy. React reads via useSnapshot().
 * Transport writes directly — no React involvement.
 */

import SocketIO from "socket.io-client";
import pako from "pako";
import { decompress } from "compress-json";
import { EventEmitter } from "eventemitter3";
import ShortId from "short-unique-id";
import type { Transport, RequestOptions } from "@parcae/model";
import { AuthGate } from "../auth-gate";
import { log } from "../log";

const DEFAULT_TIMEOUT = 120_000;

const uid = new ShortId({ length: 10 });
const SOCKETS = new Map<string, any>();

export interface SocketTransportConfig {
  url: string;
  version?: string;
  path?: string;
  token?: string | null;
}

export class SocketTransport extends EventEmitter implements Transport {
  public auth = new AuthGate();
  public isConnected = false;

  private socket: any;
  private url: string;
  private version: string;
  private token: string | null | undefined;
  private inflight = new Map<string, Promise<any>>();

  constructor(config: SocketTransportConfig) {
    super();
    this.url = config.url;
    this.version = config.version ?? "v1";
    this.token = config.token;

    const socketPath = config.path ?? "/ws";
    const socketKey = `${this.url}:${socketPath}`;

    if (SOCKETS.has(socketKey)) {
      this.socket = SOCKETS.get(socketKey);
    } else {
      this.socket = SocketIO(this.url, {
        path: socketPath,
        transports: ["websocket"],
        withCredentials: true,
      });
      SOCKETS.set(socketKey, this.socket);
    }

    this.socket.on("connect", () => {
      this.isConnected = true;
      log.debug("socket connected");
      console.log("[socket DOL-1037] connect", {
        socketId: this.socket.id,
        hasToken: this.token !== undefined && this.token !== null,
        t: performance.now(),
      });
      this._doAuth();
      this.emit("connected");
    });

    this.socket.on("disconnect", () => {
      this.isConnected = false;
      // Keep the auth token across socket reconnects. The token
      // belongs to the user's session, not this particular websocket
      // connection. Clearing it here makes the next `connect` call
      // into `_doAuth()` bail with token=undefined, leaving AuthGate
      // pending until a higher-level Provider happens to fetch a
      // token again. Backend restarts then silently kill existing
      // `useQuery` subscriptions because nothing re-authenticates
      // and re-subscribes them.
      log.debug("socket disconnected");
      console.log("[socket DOL-1037] disconnect", {
        socketId: this.socket.id,
        t: performance.now(),
      });
      this.auth.reset();
      this.emit("disconnected");
    });

    this.socket.on("error", (err: Error) => this.emit("error", err));

    if (this.socket.connected) {
      this.isConnected = true;
      log.debug("socket connected");
      this._doAuth();
    }

    if (this.token === null) {
      this.auth.resolveUnauthenticated();
    }
  }

  private _doAuth(): void {
    if (this.token === undefined) {
      console.log("[socket DOL-1037] _doAuth bailed — token undefined", {
        t: performance.now(),
      });
      return;
    }
    if (this.token === null) {
      this.auth.resolveUnauthenticated();
      return;
    }

    const t0 = performance.now();
    log.debug("authenticating...");
    console.log("[socket DOL-1037] _doAuth → emit('authenticate')", {
      socketId: this.socket.id,
      t: t0,
    });
    this.socket.emit("authenticate", this.token, (response: any) => {
      const ms = (performance.now() - t0).toFixed(0);
      const userId = response?.userId ?? null;
      console.log("[socket DOL-1037] _doAuth ← server reply", {
        userId,
        ms: Number(ms),
        t: performance.now(),
      });
      if (userId) {
        this.auth.resolve(userId);
        log.debug(`authenticated as ${userId} (${ms}ms)`);
      } else {
        this.auth.resolveUnauthenticated();
        log.debug(`auth rejected (${ms}ms)`);
      }
    });
  }

  async authenticate(token: string | null): Promise<{ userId: string | null }> {
    const tCall = performance.now();
    console.log("[socket DOL-1037] authenticate() called", {
      gateId: (this.auth as any).__id,
      gateStatus: this.auth.state.status,
      tokenChanged: token !== this.token,
      hasToken: token !== null && token !== undefined,
      t: tCall,
    });
    if (token === this.token && this.auth.state.status === "authenticated") {
      console.log("[socket DOL-1037] authenticate() early-return (cached)", {
        gateId: (this.auth as any).__id,
        t: performance.now(),
      });
      return { userId: this.auth.state.userId };
    }

    this.token = token;
    this.auth.reset();

    if (token === null) {
      this.auth.resolveUnauthenticated();
      return { userId: null };
    }

    // Wait for connection if not connected (with timeout)
    if (!this.socket.connected) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.socket.off("connect", onConnect);
          this.auth.resolveUnauthenticated();
          reject(new Error("Authentication timeout: socket not connected"));
        }, DEFAULT_TIMEOUT);
        const onConnect = () => {
          clearTimeout(timeout);
          resolve();
        };
        this.socket.once("connect", onConnect);
      });
    }

    return new Promise((resolve) => {
      this.socket.emit("authenticate", token, (response: any) => {
        const userId = response?.userId ?? null;
        if (userId) this.auth.resolve(userId);
        else this.auth.resolveUnauthenticated();
        resolve({ userId });
      });
    });
  }

  // ── Request/Response ──────────────────────────────────────────────

  private async fetch(
    method: string,
    path: string,
    data: any = {},
    options?: RequestOptions,
  ): Promise<any> {
    const waitStart = performance.now();
    if (this.auth.state.status === "pending") {
      console.log("[socket DOL-1037] fetch awaiting auth.ready", {
        gateId: (this.auth as any).__id,
        method,
        path,
        t: waitStart,
      });
    }
    await this.auth.ready;
    const waitMs = performance.now() - waitStart;
    if (waitMs > 1) {
      console.log("[socket DOL-1037] fetch auth.ready resolved", {
        gateId: (this.auth as any).__id,
        method,
        path,
        waitedMs: Number(waitMs.toFixed(0)),
        status: this.auth.state.status,
        t: performance.now(),
      });
    }

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
    }

    const upper = method.toUpperCase();
    if (upper === "GET") {
      const dedupeKey = `${path}:${JSON.stringify(data)}`;
      const existing = this.inflight.get(dedupeKey);
      if (existing) return existing;
      const req = this._call(method, path, data, options);
      this.inflight.set(dedupeKey, req);
      // Clear the dedup slot on resolve / reject without creating an
      // unhandled-rejection side chain — `.finally(...)` returns a new
      // promise that re-rejects with the original error; without an
      // attached `.catch` on THAT chain, the rejection leaks even when
      // the caller awaits and handles `req` directly. `.then(_, _)`
      // closes the loop with a no-op rejection handler.
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

  async send(event: string, ...args: any[]): Promise<void> {
    await this.auth.ready;
    this.socket.emit(event, ...args);
  }

  disconnect(): void {
    this.socket.disconnect();
    this.isConnected = false;
    log.debug("socket disconnected");
  }
  async reconnect(): Promise<void> {
    this.socket.connect();
  }
}

/** @internal — clear socket cache (for testing) */
export function _resetSockets(): void {
  SOCKETS.clear();
}
