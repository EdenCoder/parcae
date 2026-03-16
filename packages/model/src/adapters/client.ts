/**
 * FrontendAdapter — Valtio + Transport for Parcae Model.
 *
 * Transport-agnostic. Works with any implementation of the Transport interface:
 * - SocketTransport (Socket.IO — bidirectional, realtime)
 * - SSETransport (Server-Sent Events — read-heavy, simpler)
 * - GRPCTransport (gRPC — service-to-service)
 * - Or any custom transport
 */

import { proxy } from "valtio";
import {
  CHAINABLE_METHODS,
  type ChangeSet,
  type ModelAdapter,
  type ModelConstructor,
  type PatchOp,
  type QueryChain,
  type QueryStep,
} from "./types";

// ─── Transport Interface ─────────────────────────────────────────────────────

/** Per-request options that callers can pass to any RPC method. */
export interface RequestOptions {
  /** Override the default RPC timeout (in milliseconds). */
  timeout?: number;
}

/**
 * Abstract transport layer. Decouples the Model system from the wire protocol.
 *
 * Implementations:
 * - SocketTransport: Socket.IO (bidirectional, realtime subscriptions)
 * - SSETransport: HTTP + Server-Sent Events (read-heavy, simpler infra)
 * - GRPCTransport: gRPC (service-to-service, protobuf)
 */
export interface Transport {
  // ── Request/Response (RPC-style) ────────────────────────────────────
  get(path: string, data?: any, options?: RequestOptions): Promise<any>;
  post(path: string, data?: any, options?: RequestOptions): Promise<any>;
  put(path: string, data?: any, options?: RequestOptions): Promise<any>;
  patch(path: string, data?: any, options?: RequestOptions): Promise<any>;
  delete(path: string, data?: any, options?: RequestOptions): Promise<any>;

  // ── Subscriptions (realtime) ────────────────────────────────────────
  /**
   * Subscribe to a named event stream.
   * Returns a dispose function to unsubscribe.
   *
   * Socket.IO: socket.on(event, handler)
   * SSE: new EventSource(url) per channel
   * gRPC: server streaming RPC
   */
  subscribe?(event: string, handler: (...args: any[]) => void): () => void;

  /**
   * Unsubscribe from a named event stream.
   * Alternative to calling the dispose function returned by subscribe().
   */
  unsubscribe?(event: string, handler?: (...args: any[]) => void): void;

  // ── Control messages ────────────────────────────────────────────────
  /**
   * Send a control message to the server (fire-and-forget).
   *
   * Socket.IO: socket.emit(event, ...args)
   * SSE: POST /v1/__control { event, args }
   * gRPC: unary RPC
   */
  send?(event: string, ...args: any[]): void;

  // ── Connection state ────────────────────────────────────────────────
  /** Whether the transport is currently connected. */
  readonly isConnected?: boolean;
  /** Whether the transport is currently loading/connecting. */
  readonly isLoading?: boolean;

  /**
   * Listen for connection state changes.
   * Events: "connected", "disconnected", "reconnecting", "error"
   */
  on?(event: string, handler: (...args: any[]) => void): void;
  off?(event: string, handler?: (...args: any[]) => void): void;

  /** Disconnect the transport. */
  disconnect?(): void;
  /** Reconnect the transport. */
  reconnect?(): Promise<void>;
}

/**
 * Strip version prefix from a path if it starts with /v{number}.
 * The transport prepends the version automatically.
 */
function stripVersion(path: string): string {
  return path.replace(/^\/v\d+/, "");
}

// ─── FrontendAdapter ─────────────────────────────────────────────────────────

export class FrontendAdapter implements ModelAdapter {
  public transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  private p(modelPath: string): string {
    return stripVersion(modelPath);
  }

  // ── createStore ──────────────────────────────────────────────────────

  createStore(data: Record<string, any>): Record<string, any> {
    return proxy(data);
  }

  // ── save ─────────────────────────────────────────────────────────────

  async save(model: any, changes: ChangeSet): Promise<void> {
    const ModelClass = model.constructor as ModelConstructor;
    const path = this.resolvePath(ModelClass);

    if (changes.creating) {
      const result = await this.transport.post(path, model.__data);
      if (result?.id) (model as any).id = result.id;
    } else if (changes.ops.length > 0) {
      await this.transport.patch(`${path}/${model.id}`, { ops: changes.ops });
    } else if (changes.updates.length > 0) {
      const data: Record<string, any> = {};
      for (const key of changes.updates) {
        data[key] = model.__data[key];
      }
      await this.transport.put(`${path}/${model.id}`, data);
    }
  }

  // ── remove ───────────────────────────────────────────────────────────

  async remove(model: any): Promise<void> {
    const ModelClass = model.constructor as ModelConstructor;
    const path = this.resolvePath(ModelClass);
    await this.transport.delete(`${path}/${model.id}`);
  }

  // ── findById ─────────────────────────────────────────────────────────

  async findById<T>(
    modelClass: ModelConstructor<T>,
    id: string,
  ): Promise<T | null> {
    const path = this.resolvePath(modelClass);
    try {
      const data = await this.transport.get(`${path}/${id}`);
      if (!data) return null;
      return new modelClass(this, data) as T;
    } catch {
      return null;
    }
  }

  // ── query ────────────────────────────────────────────────────────────

  query<T>(modelClass: ModelConstructor<T>): QueryChain<T> {
    return this._buildQuery(modelClass, []);
  }

  private _buildQuery<T>(
    modelClass: ModelConstructor<T>,
    steps: QueryStep[],
  ): QueryChain<T> {
    const chain: any = {};

    for (const method of CHAINABLE_METHODS) {
      chain[method] = (...args: any[]) => {
        return this._buildQuery(modelClass, [
          ...steps,
          { method, args: this._serializeArgs(args) },
        ]);
      };
    }

    chain.find = async (): Promise<T[]> => {
      const path = this.resolvePath(modelClass);
      const result = await this.transport.get(path, { __query: steps });
      const items = result?.[modelClass.type + "s"] ?? result?.items ?? [];
      const models = items.map((row: any) => new modelClass(this, row));
      // Attach query subscription hash if backend provided one
      if (result?.__queryHash) {
        Object.defineProperty(models, "__queryHash", {
          value: result.__queryHash,
          enumerable: false,
        });
      }
      // Attach total count for pagination
      if (typeof result?.totalCount === "number") {
        Object.defineProperty(models, "__totalCount", {
          value: result.totalCount,
          enumerable: false,
        });
      }
      return models;
    };

    chain.first = async (): Promise<T | null> => {
      const all = await chain.find();
      return all[0] ?? null;
    };

    chain.count = async (): Promise<number> => {
      const path = this.resolvePath(modelClass);
      const result = await this.transport.get(path, {
        __query: steps,
        __count: true,
      });
      return result?.total ?? 0;
    };

    chain.__steps = steps;
    chain.__modelType = modelClass.type;
    chain.__modelClass = modelClass;
    chain.__adapter = this;

    return chain as QueryChain<T>;
  }

  private _serializeArgs(args: any[]): any[] {
    return args.map((arg) => {
      if (typeof arg === "function") {
        // Capture nested builder calls: .where((b) => b.where(...).orWhere(...))
        const nestedSteps: QueryStep[] = [];
        const recorder: any = new Proxy(
          {},
          {
            get: (_target, method: string) => {
              return (...innerArgs: any[]) => {
                nestedSteps.push({
                  method,
                  args: this._serializeArgs(innerArgs),
                });
                return recorder;
              };
            },
          },
        );
        arg(recorder);
        return { __nested: nestedSteps };
      }
      return arg;
    });
  }

  // ── patch ────────────────────────────────────────────────────────────

  async patch(model: any, ops: PatchOp[]): Promise<void> {
    const ModelClass = model.constructor as ModelConstructor;
    const path = this.resolvePath(ModelClass);
    await this.transport.patch(`${path}/${model.id}`, { ops });
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private resolvePath(modelClass: ModelConstructor): string {
    if (!modelClass.path && !modelClass.type) {
      throw new Error("Model has no path or type");
    }
    const fullPath = modelClass.path ?? `/v1/${modelClass.type}s`;
    return this.p(fullPath);
  }
}
