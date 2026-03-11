import { log } from "../logger";
/**
 * QuerySubscriptionManager — server-side realtime query subscriptions.
 *
 * Clients subscribe to queries. On model changes, queries are re-evaluated,
 * diffed against cached results, and surgical add/remove/update ops are
 * emitted to subscribers.
 *
 * Update ops carry RFC 6902 JSON Patch arrays — only the changed fields are
 * sent over the wire, not the entire document.
 *
 * Extracted from Dollhouse Studio's adapters/subscriptions.ts (308 lines).
 */

import { createHash } from "node:crypto";
import type { QueryChain } from "@parcae/model";
import { compare, type Operation } from "fast-json-patch";

// ─── Types ───────────────────────────────────────────────────────────────────

interface CachedQuery {
  hash: string;
  modelType: string;
  query: QueryChain<any>;
  result: Map<string, Record<string, any>>;
  subscribers: Set<string>;
}

interface SubscriptionOptions {
  socketId: string;
  query: QueryChain<any>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashFrom(toSQL: { sql: string; bindings: any[] }): string {
  const payload = JSON.stringify({ sql: toSQL.sql, bindings: toSQL.bindings });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** JSON round-trip to normalize Dates to strings, strip undefined, etc. */
function jsonClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// ─── Manager ─────────────────────────────────────────────────────────────────

export class QuerySubscriptionManager {
  private queries = new Map<string, CachedQuery>();
  private socketQueries = new Map<string, Set<string>>();
  private typeIndex = new Map<string, Set<string>>();

  private emitToSocket: (socketId: string, event: string, data: any) => void;

  constructor(
    emitToSocket: (socketId: string, event: string, data: any) => void,
  ) {
    this.emitToSocket = emitToSocket;
  }

  // ── Subscribe ──────────────────────────────────────────────────────

  async subscribe(
    opts: SubscriptionOptions,
  ): Promise<{ hash: string; items: Record<string, any>[] }> {
    const { socketId, query } = opts;
    const modelType = (query as any).__modelType;
    const hash = hashFrom(query.exec().toSQL());

    let cached = this.queries.get(hash);

    if (cached) {
      cached.subscribers.add(socketId);
    } else {
      const rows = await this._execQuery(query);
      const result = new Map<string, Record<string, any>>();
      for (const row of rows) {
        const clean = jsonClone(row);
        result.set(clean.id, clean);
      }

      cached = {
        hash,
        modelType,
        query,
        result,
        subscribers: new Set([socketId]),
      };
      this.queries.set(hash, cached);

      if (!this.typeIndex.has(modelType)) {
        this.typeIndex.set(modelType, new Set());
      }
      this.typeIndex.get(modelType)!.add(hash);
    }

    if (!this.socketQueries.has(socketId)) {
      this.socketQueries.set(socketId, new Set());
    }
    this.socketQueries.get(socketId)!.add(hash);

    return { hash, items: [...cached.result.values()] };
  }

  // ── Unsubscribe ────────────────────────────────────────────────────

  unsubscribe(socketId: string, hash: string): void {
    const cached = this.queries.get(hash);
    if (!cached) return;

    cached.subscribers.delete(socketId);
    this.socketQueries.get(socketId)?.delete(hash);

    if (cached.subscribers.size === 0) {
      this.queries.delete(hash);
      this.typeIndex.get(cached.modelType)?.delete(hash);
    }
  }

  unsubscribeAll(socketId: string): void {
    const hashes = this.socketQueries.get(socketId);
    if (!hashes) return;

    for (const hash of hashes) {
      const cached = this.queries.get(hash);
      if (!cached) continue;
      cached.subscribers.delete(socketId);
      if (cached.subscribers.size === 0) {
        this.queries.delete(hash);
        this.typeIndex.get(cached.modelType)?.delete(hash);
      }
    }

    this.socketQueries.delete(socketId);
  }

  // ── On Model Change ────────────────────────────────────────────────

  onModelChange(modelType: string): void {
    const hashes = this.typeIndex.get(modelType);
    if (!hashes || hashes.size === 0) return;

    for (const hash of hashes) {
      const cached = this.queries.get(hash);
      if (!cached) continue;
      this._reeval(cached).catch((err) => {
        log.error(`subscriptions: re-eval failed for ${hash}:`, err);
      });
    }
  }

  // ── Re-evaluation ──────────────────────────────────────────────────

  private async _reeval(cached: CachedQuery): Promise<void> {
    if (cached.subscribers.size === 0) return;

    const rows = await this._execQuery(cached.query);
    const newResult = new Map<string, Record<string, any>>();
    for (const row of rows) {
      const clean = jsonClone(row);
      newResult.set(clean.id, clean);
    }

    const ops: Array<
      | { op: "add"; id: string; data: Record<string, any> }
      | { op: "remove"; id: string }
      | { op: "update"; id: string; patch: Operation[] }
    > = [];

    for (const [id, data] of newResult) {
      const prev = cached.result.get(id);
      if (!prev) {
        ops.push({ op: "add", id, data });
      } else {
        const patch = compare(prev, data);
        if (patch.length > 0) {
          ops.push({ op: "update", id, patch });
        }
      }
    }

    for (const id of cached.result.keys()) {
      if (!newResult.has(id)) ops.push({ op: "remove", id });
    }

    cached.result = newResult;

    if (ops.length > 0) {
      for (const socketId of cached.subscribers) {
        this.emitToSocket(socketId, `query:${cached.hash}`, ops);
      }
    }
  }

  // ── Query Execution ────────────────────────────────────────────────

  private async _execQuery(
    query: QueryChain<any>,
  ): Promise<Record<string, any>[]> {
    const models = await query.clone().find();
    return Promise.all(
      (models as any[]).map((m: any) => m.sanitize?.() ?? m.__data ?? m),
    );
  }

  // ── Stats ──────────────────────────────────────────────────────────

  get stats() {
    let totalSubscribers = 0;
    for (const cached of this.queries.values())
      totalSubscribers += cached.subscribers.size;
    return {
      queries: this.queries.size,
      subscribers: totalSubscribers,
      sockets: this.socketQueries.size,
    };
  }
}
