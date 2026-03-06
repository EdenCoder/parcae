/**
 * SocketTransport — Socket.IO transport with AuthGate.
 *
 * Connection and authentication are separate concerns:
 * - Constructor connects the socket
 * - authenticate(token) sends the token and waits for server confirmation
 * - fetch() awaits auth.ready before sending any request
 * - Disconnect resets the gate; reconnect event lets the Provider re-auth
 */

import SocketIO from "socket.io-client";
import pako from "pako";
import { decompress } from "compress-json";
import { EventEmitter } from "eventemitter3";
import ShortId from "short-unique-id";
import type { Transport } from "@parcae/model";
import { AuthGate } from "../auth-gate";

const uid = new ShortId({ length: 10 });

export interface SocketTransportConfig {
  url: string;
  version?: string;
  path?: string;
}

export class SocketTransport extends EventEmitter implements Transport {
  public auth = new AuthGate();
  public isConnected = false;
  public isLoading = false;
  public userId: string | null = null;

  private socket: any;
  private url: string;
  private version: string;
  private inflight = new Map<string, Promise<any>>();

  constructor(config: SocketTransportConfig) {
    super();
    this.url = config.url;
    this.version = config.version ?? "v1";

    this.socket = SocketIO(this.url, {
      path: config.path ?? "/ws",
      transports: ["websocket"],
      withCredentials: true,
    });

    this.socket.on("connect", () => {
      const wasConnected = this.isConnected;
      this.isConnected = true;
      this.emit(wasConnected ? "reconnected" : "connected");
    });

    this.socket.on("disconnect", () => {
      this.isConnected = false;
      this.auth.reset();
      this.emit("disconnected");
    });

    this.socket.on("error", (err: Error) => {
      this.emit("error", err);
    });
  }

  // ── Authenticate ──────────────────────────────────────────────────

  /**
   * Authenticate with the backend. Resolves the AuthGate when done.
   *
   * - token=string → send to server, wait for confirmation
   * - token=null → no auth, resolve gate immediately (unauthenticated)
   */
  async authenticate(token: string | null): Promise<{ userId: string | null }> {
    this.auth.reset();
    this.userId = null;

    if (!token) {
      this.auth.resolve();
      return { userId: null };
    }

    // Wait for socket to be connected
    if (!this.socket.connected) {
      await new Promise<void>((resolve) => {
        if (this.socket.connected) return resolve();
        this.socket.once("connect", () => resolve());
      });
    }

    // Send token, wait for server callback
    return new Promise((resolve) => {
      this.socket.emit("authenticate", token, (response: any) => {
        this.userId = response?.userId ?? null;
        this.auth.resolve();
        resolve({ userId: this.userId });
      });
    });
  }

  // ── Request/Response ──────────────────────────────────────────────

  private async fetch(
    method: string,
    path: string,
    data: any = {},
  ): Promise<any> {
    // Wait for auth to be confirmed before any request
    await this.auth.ready;

    // Wait for socket connection
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

    // Deduplicate GET requests
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
          if (parsed.success) {
            resolve(parsed.result);
          } else {
            reject(
              new Error(
                parsed.message || parsed.error || `${method} ${path} failed`,
              ),
            );
          }
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

  // ── Subscriptions ─────────────────────────────────────────────────

  subscribe(event: string, handler: (...args: any[]) => void): () => void {
    this.socket.on(event, handler);
    return () => this.socket.off(event, handler);
  }

  unsubscribe(event: string, handler?: (...args: any[]) => void): void {
    this.socket.off(event, handler);
  }

  // ── Control ───────────────────────────────────────────────────────

  async send(event: string, ...args: any[]): Promise<void> {
    await this.auth.ready;
    this.socket.emit(event, ...args);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  disconnect(): void {
    this.socket.disconnect();
    this.isConnected = false;
  }

  async reconnect(): Promise<void> {
    this.socket.connect();
  }
}

export default SocketTransport;
