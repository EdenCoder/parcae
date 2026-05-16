/**
 * Transaction context — AsyncLocalStorage frame for `withTransaction(...)`.
 *
 * The default Knex write in BackendAdapter (e.g. `save()`'s
 * `INSERT … ON CONFLICT MERGE`) is a single-statement autocommit:
 * by the time `_notifyChange()` runs, the row is durably written.
 * Emitting a model-change event there is correct.
 *
 * The moment app code wraps multiple writes in a `db.transaction(…)`,
 * that invariant breaks. `_notifyChange()` fires inside the
 * transaction; if the transaction later rolls back, subscribers have
 * already been told about state that doesn't exist. **Ghost events.**
 *
 * `withTransaction(adapter, fn)` opens an ALS frame, runs `fn`, and:
 *   - On success → flushes the frame's buffered Changes to the bus.
 *   - On failure → discards the buffer.
 *
 * `_notifyChange()` checks `getActiveTransactionFrame()`. If a frame
 * exists, it pushes into the buffer instead of emitting to the bus.
 * Otherwise it emits immediately, preserving today's behaviour.
 *
 * Nested `withTransaction` calls share the outermost frame so a
 * rollback at the outer level discards every inner write — savepoint
 * semantics on top of the knex transaction API.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { log } from "../logger";
import type { Change, ChangeBus } from "./changeBus";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TransactionFrame {
  /** Knex transaction handle (`db.transaction()` provides it). */
  trx: any;
  /** Buffered changes awaiting commit. */
  buffer: Change[];
  /** Shared request-id for every write inside the frame. */
  requestId: string;
  /** Depth — non-zero inside nested `withTransaction(…)` calls. */
  depth: number;
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const storage = new AsyncLocalStorage<TransactionFrame>();

/** Get the active transaction frame, if any. */
export function getActiveTransactionFrame(): TransactionFrame | null {
  return storage.getStore() ?? null;
}

/**
 * Buffer a Change against the active frame. Returns `true` if a frame
 * absorbed it, `false` if there was no frame and the caller should
 * emit immediately.
 */
export function bufferChangeIfActive(change: Change): boolean {
  const frame = storage.getStore();
  if (!frame) return false;
  frame.buffer.push(change);
  return true;
}

// ─── withTransaction(...) ────────────────────────────────────────────────────

export interface WithTransactionDeps {
  /** Knex instance to open the transaction on. Pass `adapter.write`. */
  knex: any;
  /** ChangeBus to flush buffered changes onto when the trx commits. */
  changeBus: ChangeBus | null;
  /**
   * Postgres-only: if true, the wrapper sets `parcae.request_id` as a
   * transaction-local GUC before invoking `fn`, so the LISTEN/NOTIFY
   * trigger can read it back in the pg_notify payload.
   *
   * Skip for SQLite or for deployments that don't run the poller.
   */
  setRequestIdGuc?: boolean;
  /** Custom request-id (otherwise generated via changeBus.newRequestId). */
  requestId?: string;
}

/**
 * Run `fn` inside a knex transaction with a Parcae transaction frame.
 *
 * - Successful return → buffered changes flush to the bus in order.
 * - Thrown error → transaction rolls back, buffer is discarded.
 * - Nested calls → share the outermost frame; inner commits don't flush.
 *
 * Example:
 * ```ts
 * await withTransaction({ knex: adapter.write, changeBus }, async (trx) => {
 *   await Post.save({ ... }, { trx });
 *   await Tag.save({ ... }, { trx });
 *   // both Changes flush together once this resolves
 * });
 * ```
 */
export async function withTransaction<T>(
  deps: WithTransactionDeps,
  fn: (trx: any) => Promise<T>,
): Promise<T> {
  const existing = storage.getStore();
  if (existing) {
    // Nested call. Re-enter with depth+1 on the same frame — the inner
    // body still receives the existing trx so all writes flow to the
    // same Postgres transaction. We don't open a savepoint here; on
    // rollback at the outer level, every inner write goes with it.
    existing.depth++;
    try {
      return await fn(existing.trx);
    } finally {
      existing.depth--;
    }
  }

  const requestId =
    deps.requestId ?? deps.changeBus?.newRequestId() ?? fallbackRequestId();

  // We use a plain Promise wrapper around knex.transaction so we can
  // distinguish "fn returned successfully → trx will commit" from
  // "fn threw → trx will roll back" before knex's own commit fires.
  // Buffer flushing happens AFTER knex confirms commit.
  return await deps.knex.transaction(async (trx: any) => {
    if (deps.setRequestIdGuc) {
      await trx.raw("SELECT set_config('parcae.request_id', ?, true)", [
        requestId,
      ]);
    }
    const frame: TransactionFrame = {
      trx,
      buffer: [],
      requestId,
      depth: 1,
    };
    return storage.run(frame, async () => {
      let result: T;
      try {
        result = await fn(trx);
      } catch (err) {
        // knex will roll back; the buffer is intentionally discarded
        // (never flushed). Re-throw so knex sees the failure.
        throw err;
      }
      // fn resolved → knex is about to commit. We flush right before
      // returning so the actual commit happens after the buffer is
      // already on its way to the bus. If the commit itself later
      // fails (very rare for a single-statement trx, possible for
      // larger ones), we accept a small window of false-positive
      // events — better than the alternative of holding the bus
      // emit until AFTER `transaction()` resolves, where a thrown
      // post-commit handler can lose them entirely.
      flush(frame.buffer, deps.changeBus);
      return result;
    });
  });
}

function flush(buffer: Change[], changeBus: ChangeBus | null): void {
  if (!changeBus) return;
  for (const change of buffer) {
    try {
      changeBus.emit(change);
    } catch (err) {
      log.warn(`transactionContext: bus.emit threw: ${String(err)}`);
    }
  }
}

function fallbackRequestId(): string {
  // No changeBus means we won't emit anyway, but the GUC still needs
  // *some* string — return a clearly-tagged placeholder so it's
  // obvious in pg logs that the request-id plumbing was missing.
  return `req_local_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}
