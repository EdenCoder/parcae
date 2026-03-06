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
import type { Transport } from "@parcae/model";
import { AuthGate } from "../auth-gate";
import { log } from "../log";

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
      log.info("socket connected");
      this._doAuth();
      this.emit("connected");
    });

    this.socket.on("disconnect", () => {
      this.isConnected = false;
      log.info("socket disconnected");
      this.auth.reset();
      this.emit("disconnected");
    });

    this.socket.on("error", (err: Error) => this.emit("error", err));

    if (this.socket.connected) {
      this.isConnected = true;
      log.info("socket connected");
      this._doAuth();
    }

    if (this.token === null) {
      this.auth.resolveUnauthenticated();
    }
  }

  private _doAuth(): void {
    if (this.token === undefined) return;
    if (this.token === null) {
      this.auth.resolveUnauthenticated();
      return;
    }

      log.info("authenticating with token", this.token?.slice(0, 8) + "...");
    this.socket.emit("authenticate", this.token, (response: any) => {
      const userId = response?.userId ?? null;
      if (userId) {
        this.auth.resolve(userId);
      } else {
        this.auth.resolveUnauthenticated();
      }
    });
  }

  async authenticate(token: string | null): Promise<{ userId: string | null }> {
    this.token = token;
    this.auth.reset();

    if (token === null) {
      this.auth.resolveUnauthenticated();
      return { userId: null };
    }

    if (!this.socket.connected) {
      return new Promise((resolve) => {
        const handler = () => {
          this.socket.off("connect", handler);
          this.socket.emit("authenticate", token, (response: any) => {
            const userId = response?.userId ?? null;
            if (userId) this.auth.resolve(userId);
            else this.auth.resolveUnauthenticated();
            resolve({ userId });
          });
        };
        this.socket.once("connect", handler);
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
  ): Promise<any> {
    await this.auth.ready;

    if (!this.socket.connected) {
      await new Promise<void>((resolve, reject) => {
        if (this.socket.connected) return resolve();
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Connection timeout"));
        }, 30000);
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
      const req = this._call(method, path, data);
      this.inflight.set(dedupeKey, req);
      req.finally(() => this.inflight.delete(dedupeKey));
      return req;
    }

    return this._call(method, path, data);
  }

  private _call(method: string, path: string, data: any): Promise<any> {
    const id = uid.rnd();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.socket.off(id);
        reject(new Error(`RPC timeout: ${method} ${path}`));
      }, 30000);

      this.socket.once(id, (msg: any) => {
        clearTimeout(timeout);
        try {
          const uncompressed = pako.ungzip(msg, { to: "string" });
          const parsed = decompress(JSON.parse(uncompressed));
          if (parsed.success) resolve(parsed.result);
          else
            reject(
              new Error(
                parsed.message || parsed.error || `${method} ${path} failed`,
              ),
            );
        } catch (err) {
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

  async get(path: string, data?: any): Promise<any> {
    return this.fetch("GET", path, data);
  }
  async post(path: string, data?: any): Promise<any> {
    return this.fetch("POST", path, data);
  }
  async put(path: string, data?: any): Promise<any> {
    return this.fetch("PUT", path, data);
  }
  async patch(path: string, data?: any): Promise<any> {
    return this.fetch("PATCH", path, data);
  }
  async delete(path: string, data?: any): Promise<any> {
    return this.fetch("DELETE", path, data);
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
      log.info("socket disconnected");
  }
  async reconnect(): Promise<void> {
    this.socket.connect();
  }
}

export default SocketTransport;

/** @internal — clear socket cache (for testing) */
export function _resetSockets(): void { SOCKETS.clear(); }

