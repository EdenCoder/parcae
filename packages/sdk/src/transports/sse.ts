/**
 * SSETransport — HTTP + Server-Sent Events implementation of the Transport interface.
 *
 * Request/response via standard fetch(). Subscriptions via EventSource.
 * Simpler than Socket.IO — no websocket infra needed. Good for read-heavy
 * apps, serverless backends, or environments where WebSocket isn't available.
 *
 * Trade-offs vs SocketTransport:
 * - Simpler infra (no sticky sessions, works behind any CDN/proxy)
 * - Server → client streaming only (no client → server streaming)
 * - Request/response is standard HTTP (cacheable, observable, debuggable)
 * - No compression (relies on HTTP gzip)
 * - No request deduplication (relies on HTTP/2 multiplexing)
 */

import { EventEmitter } from "eventemitter3";
import type { Transport, RequestOptions } from "@parcae/model";

export interface SSETransportConfig {
  /** Base URL of the Parcae backend. */
  url: string;
  /** API key or async function returning a key. */
  key?: string | null | (() => Promise<string | null>);
  /** API version prefix. Default: "v1" */
  version?: string;
}

export class SSETransport extends EventEmitter implements Transport {
  private url: string;
  private version: string;
  private apiKey: string | null | (() => Promise<string | null>);
  private key: string | null = null;
  private eventSources = new Map<string, EventSource>();

  public isConnected = true; // HTTP is "always connected"
  public loading: Promise<void>;

  constructor(config: SSETransportConfig) {
    super();
    this.url = config.url.replace(/\/$/, "");
    this.version = config.version ?? "v1";
    this.apiKey = config.key ?? null;
    this.loading = this.resolveKey();
  }

  private async resolveKey(): Promise<void> {
    try {
      this.key =
        typeof this.apiKey === "function" ? await this.apiKey() : this.apiKey;
      this.emit("connected");
    } catch (err) {
      this.emit("error", err);
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.key) h["Authorization"] = `Bearer ${this.key}`;
    return h;
  }

  private fullUrl(path: string): string {
    return `${this.url}/${this.version}${path}`;
  }

  // ── Request/Response ──────────────────────────────────────────────────

  private async request(
    method: string,
    path: string,
    data?: any,
    options?: RequestOptions,
  ): Promise<any> {
    await this.loading;

    const isGet = method.toUpperCase() === "GET";
    let url = this.fullUrl(path);

    if (isGet && data) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(data)) {
        params.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
      url += `?${params.toString()}`;
    }

    const controller = options?.timeout ? new AbortController() : undefined;
    const timer = options?.timeout
      ? setTimeout(() => controller!.abort(), options.timeout)
      : undefined;

    try {
      const res = await fetch(url, {
        method: method.toUpperCase(),
        headers: this.headers(),
        body: isGet ? undefined : JSON.stringify(data),
        signal: controller?.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || body.message || `HTTP ${res.status}`);
      }

      const body = await res.json();
      if (body.success === false)
        throw new Error(body.error || "Request failed");
      return body.result ?? body;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async get(path: string, data?: any, options?: RequestOptions): Promise<any> {
    return this.request("GET", path, data, options);
  }
  async post(path: string, data?: any, options?: RequestOptions): Promise<any> {
    return this.request("POST", path, data, options);
  }
  async put(path: string, data?: any, options?: RequestOptions): Promise<any> {
    return this.request("PUT", path, data, options);
  }
  async patch(
    path: string,
    data?: any,
    options?: RequestOptions,
  ): Promise<any> {
    return this.request("PATCH", path, data, options);
  }
  async delete(
    path: string,
    data?: any,
    options?: RequestOptions,
  ): Promise<any> {
    return this.request("DELETE", path, data, options);
  }

  // ── Subscriptions (via Server-Sent Events) ────────────────────────────

  subscribe(event: string, handler: (...args: any[]) => void): () => void {
    const url = `${this.url}/${this.version}/__events/${encodeURIComponent(event)}`;
    const source = new EventSource(url, { withCredentials: true });

    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        handler(data);
      } catch {
        handler(e.data);
      }
    };

    source.onerror = () => {
      // EventSource auto-reconnects
    };

    this.eventSources.set(event, source);

    return () => {
      source.close();
      this.eventSources.delete(event);
    };
  }

  unsubscribe(event: string): void {
    const source = this.eventSources.get(event);
    if (source) {
      source.close();
      this.eventSources.delete(event);
    }
  }

  // ── Control messages ──────────────────────────────────────────────────

  async send(event: string, ...args: any[]): Promise<void> {
    await this.request("POST", "/__control", { event, args });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  disconnect(): void {
    for (const [, source] of this.eventSources) source.close();
    this.eventSources.clear();
    this.isConnected = false;
    this.emit("disconnected");
  }

  async reconnect(): Promise<void> {
    this.loading = this.resolveKey();
    await this.loading;
  }
}
