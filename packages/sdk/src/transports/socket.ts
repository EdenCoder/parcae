/**
 * SocketTransport — Socket.IO implementation of the Transport interface.
 *
 * Bidirectional, full-duplex. Best for apps that need realtime subscriptions
 * (live query updates, collaborative editing, chat, etc.).
 *
 * Extracted from Dollhouse Studio's Dollhouse.ts (667 lines).
 */

import SocketIO from "socket.io-client";
import pako from "pako";
import { decompress } from "compress-json";
import { EventEmitter } from "eventemitter3";
import ShortId from "short-unique-id";
import type { Transport } from "@parcae/model";

const uid = new ShortId({ length: 10 });
const SOCKET_CONNECTIONS = new Map<string, any>();

export interface SocketTransportConfig {
  url: string;
  key?: string | null | (() => Promise<string | null>);
  version?: string;
  /** Socket.IO path. Default: "/ws" */
  path?: string;
}

export class SocketTransport extends EventEmitter implements Transport {
  private socket: any = null;
  private pendingHandlers: Array<{
    event: string;
    handler: (...args: any[]) => void;
  }> = [];
  private apiKey: string | null | (() => Promise<string | null>);
  private key: string | null = null;
  private url: string;
  private version: string;
  private socketPath: string;
  private waitForAuth: Promise<void> | null = null;
  private resolveAuth: (() => void) | null = null;
  private inflight = new Map<string, Promise<any>>();

  public loading: Promise<void>;
  public isLoading = true;
  public isConnected = false;
  public isConnecting = false;
  public authVersion = 0;

  constructor(config: SocketTransportConfig) {
    super();
    this.url = config.url;
    this.apiKey = config.key ?? null;
    this.version = config.version ?? "v1";
    this.socketPath = config.path ?? "/ws";
    this.loading = this.init(this.apiKey);
  }

  // ── Auth ──────────────────────────────────────────────────────────────

  async setKey(
    key: string | null | (() => Promise<string | null>),
  ): Promise<void> {
    this.apiKey = key;
    this.isLoading = true;
    this.loading = this.init(key);
    await this.loading;
  }

  // ── Init ──────────────────────────────────────────────────────────────

  private async init(
    key: string | null | (() => Promise<string | null>),
  ): Promise<void> {
    this.isLoading = true;
    this.isConnecting = true;

    try {
      this.key = typeof key === "function" ? await key() : key;
      const socketKey = `${this.url}:${this.version}`;

      if (!SOCKET_CONNECTIONS.has(socketKey)) {
        SOCKET_CONNECTIONS.set(
          socketKey,
          SocketIO(this.url, {
            path: this.socketPath,
            agent: true,
            transports: ["websocket"],
            withCredentials: true,
            query: { key: this.key ?? undefined, compression: true },
          }),
        );
      }

      this.socket = SOCKET_CONNECTIONS.get(socketKey);

      if (this.key) {
        const prevResolve = this.resolveAuth;
        this.waitForAuth = new Promise<void>((resolve) => {
          this.resolveAuth = resolve;
          this.socket.emit("authenticate", this.key, () => {
            this.waitForAuth = null;
            this.resolveAuth = null;
            this.authVersion++;
            this.emit("authenticated");
            if (prevResolve) prevResolve();
            resolve();
          });
        });
      } else {
        this.waitForAuth = null;
        this.resolveAuth = null;
      }

      this.isLoading = false;
    } catch (error) {
      this.isLoading = false;
      this.isConnecting = false;
      this.emit("error", error);
      throw error;
    }

    this.setupEvents();
  }

  private setupEvents(): void {
    if (!this.socket) return;

    for (const { event, handler } of this.pendingHandlers) {
      this.socket.on(event, handler);
    }
    this.pendingHandlers = [];

    let hasConnected = this.isConnected;
    this.socket.off("connect");
    this.socket.off("disconnect");
    this.socket.off("error");

    this.socket.on("connect", () => {
      const wasDisconnected = !this.isConnected && hasConnected;
      this.isConnected = true;
      this.isConnecting = false;
      hasConnected = true;
      this.emit(wasDisconnected ? "reconnected" : "connected");
    });

    this.socket.on("disconnect", () => {
      this.isConnected = false;
      this.emit("disconnected");
    });

    this.socket.on("error", (error: Error) => {
      this.emit("error", error);
    });
  }

  // ── Request/Response ──────────────────────────────────────────────────

  private async fetch(
    method: string,
    path: string,
    data: any = {},
  ): Promise<any> {
    await this.loading;
    if (this.waitForAuth) await this.waitForAuth;
    if (!this.socket) throw new Error("Socket not initialized");

    const upper = method.toUpperCase();
    if (upper === "GET") {
      const dedupeKey = `GET:${path}:${this.authVersion}:${JSON.stringify(data)}`;
      const existing = this.inflight.get(dedupeKey);
      if (existing) return existing;
      const req = this._doFetch(method, path, data);
      this.inflight.set(dedupeKey, req);
      req.finally(() => this.inflight.delete(dedupeKey));
      return req;
    }

    return this._doFetch(method, path, data);
  }

  private async _doFetch(
    method: string,
    path: string,
    data: any = {},
  ): Promise<any> {
    if (!this.isConnected) {
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
          reject(new Error(`Connection failed: ${err.message}`));
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

    const id = uid.rnd();

    return new Promise((resolve, reject) => {
      this.socket.once(id, (msg: any) => {
        try {
          const uncompressed = pako.ungzip(msg, { to: "string" });
          const { success, result, message, error } = decompress(
            JSON.parse(uncompressed),
          );
          if (success) resolve(result);
          else
            reject(
              new Error(
                message || error || `Request failed: ${method}:${path}`,
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
    return this.fetch("get", path, data);
  }
  async post(path: string, data?: any): Promise<any> {
    return this.fetch("post", path, data);
  }
  async put(path: string, data?: any): Promise<any> {
    return this.fetch("put", path, data);
  }
  async patch(path: string, data?: any): Promise<any> {
    return this.fetch("patch", path, data);
  }
  async delete(path: string, data?: any): Promise<any> {
    return this.fetch("delete", path, data);
  }

  // ── Subscriptions ─────────────────────────────────────────────────────

  subscribe(event: string, handler: (...args: any[]) => void): () => void {
    if (this.socket) {
      this.socket.on(event, handler);
    } else {
      this.pendingHandlers.push({ event, handler });
    }
    return () => this.unsubscribe(event, handler);
  }

  unsubscribe(event: string, handler?: (...args: any[]) => void): void {
    if (this.socket) this.socket.off(event, handler);
    this.pendingHandlers = this.pendingHandlers.filter(
      (h) => !(h.event === event && (!handler || h.handler === handler)),
    );
  }

  // ── Control messages ──────────────────────────────────────────────────

  async send(event: string, ...args: any[]): Promise<void> {
    if (!this.isConnected && this.socket) {
      await new Promise<void>((resolve) => {
        if (this.socket.connected) return resolve();
        this.socket.once("connect", () => resolve());
      });
    }
    if (this.waitForAuth) await this.waitForAuth;
    if (this.socket) this.socket.emit(event, ...args);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      SOCKET_CONNECTIONS.delete(`${this.url}:${this.version}`);
      this.socket = null;
      this.isConnected = false;
    }
  }

  async reconnect(): Promise<void> {
    this.loading = this.init(this.apiKey);
    await this.loading;
  }
}

export default SocketTransport;
