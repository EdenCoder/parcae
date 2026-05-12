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
import fastJsonPatch from "fast-json-patch";
import type { Operation } from "fast-json-patch";

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

/**
 * Per-socket subscription cap. Without it, a misbehaving client can
 * subscribe to N distinct queries — each cached server-side with its
 * own row set + per-model-change re-eval cost — and exhaust the
 * server. 100 is well above typical UI usage (each page mounts a
 * handful of `useQuery`s) and well below the threshold where a
 * single socket starts to materially impact server memory.
 *
 * Hitting the cap is a development-time mistake or an attack, not a
 * legitimate runtime case — log loudly and silently drop the new
 * subscription's items (the client gets an empty result for that
 * query, consistent with how an unsubscribed query reads).
 */
const MAX_SUBSCRIPTIONS_PER_SOCKET = 100;

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
    // `__modelType` lives on the QueryChain interface as @internal —
    // populated by every chain factory (`Model._query` → `lazyQuery`
    // server-side, the adapter's `query()` factory client-side).
    const modelType = query.__modelType;
    const hash = hashFrom(query.exec().toSQL());

    // Per-socket cap enforced BEFORE the cache lookup so a socket
    // can't unlock new subscriptions by re-requesting an already-
    // cached hash. The cap is on the socket's distinct-hash set
    // size, not on the cached query's total subscribers — sharing a
    // query across many sockets is fine and intentional.
    const existing = this.socketQueries.get(socketId);
    const alreadySubscribed = existing?.has(hash) ?? false;
    if (
      !alreadySubscribed &&
      (existing?.size ?? 0) >= MAX_SUBSCRIPTIONS_PER_SOCKET
    ) {
      log.warn(
        `subscriptions: socket ${socketId} hit the ${MAX_SUBSCRIPTIONS_PER_SOCKET} subscription cap — refusing new query for ${modelType}`,
      );
      return { hash, items: [] };
    }

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
        const patch = fastJsonPatch.compare(prev, data);
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
    // `query.find()` returns `Promise<any[]>` (the chain's generic is
    // `any`); the projection runs `sanitize()` for every Model row
    // and falls back to `__data` for any non-Model row that snuck
    // through (defensive — the default `sanitize` is now on Model
    // itself, so the fallback is effectively unreachable for real
    // model classes).
    return Promise.all(
      models.map((m: any) => m.sanitize?.() ?? m.__data ?? m),
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
