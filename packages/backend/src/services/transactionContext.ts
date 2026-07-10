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
  /** Closed frames may remain visible to detached ALS work but are unusable. */
  state: "active" | "closed";
  /** Buffered changes awaiting commit. */
  buffer: Change[];
  /** Shared request-id for every write inside the frame. */
  requestId: string;
  /** Side effects that may run only after Knex confirms commit. */
  afterCommit: Array<() => Promise<void> | void>;
  /** Compensations that run if the outermost transaction fails. */
  afterRollback: Array<() => Promise<void> | void>;
  /** Depth — non-zero inside nested `withTransaction(…)` calls. */
  depth: number;
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const storage = new AsyncLocalStorage<TransactionFrame>();

/** Get the active transaction frame, if any. */
export function getActiveTransactionFrame(): TransactionFrame | null {
  const frame = storage.getStore();
  return frame?.state === "active" ? frame : null;
}

/** Get the active Knex transaction handle, if any. */
export function activeTransactionHandle(): any | null {
  return getActiveTransactionFrame()?.trx ?? null;
}

/**
 * Buffer a Change against the active frame. Returns `true` if a frame
 * absorbed it, `false` if there was no frame and the caller should
 * emit immediately.
 */
export function bufferChangeIfActive(change: Change): boolean {
  const frame = getActiveTransactionFrame();
  if (!frame) return false;
  frame.buffer.push(change);
  return true;
}

/** Queue a side effect until commit. Returns false outside a transaction. */
export function runAfterCommitIfActive(
  callback: () => Promise<void> | void,
): boolean {
  const frame = getActiveTransactionFrame();
  if (!frame) return false;
  frame.afterCommit.push(callback);
  return true;
}

/** Queue a compensation for outermost rollback. Returns false outside a transaction. */
export function runAfterRollbackIfActive(
  callback: () => Promise<void> | void,
): boolean {
  const frame = getActiveTransactionFrame();
  if (!frame) return false;
  frame.afterRollback.push(callback);
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
  const existing = getActiveTransactionFrame();
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

  const transaction: { frame: TransactionFrame | null } = { frame: null };
  let result: T;
  try {
    result = await deps.knex.transaction(async (trx: any) => {
      if (deps.setRequestIdGuc) {
        await trx.raw("SELECT set_config('parcae.request_id', ?, true)", [
          requestId,
        ]);
      }
      transaction.frame = {
        trx,
        state: "active",
        buffer: [],
        requestId,
        afterCommit: [],
        afterRollback: [],
        depth: 1,
      };
      const value = await storage.run(transaction.frame, () => fn(trx));
      // Reserve only rows that have corresponding hook changes. Raw-only
      // writes must remain visible through LISTEN, including raw writes in a
      // mixed transaction that target a different table/id.
      if (deps.changeBus) {
        for (const change of transaction.frame.buffer) {
          deps.changeBus.reserve(change);
        }
      }
      return value;
    });
  } catch (err) {
    const frame = transaction.frame;
    if (frame) {
      frame.state = "closed";
      await runAfterRollback(frame.afterRollback);
      frame.afterRollback.length = 0;
      frame.afterCommit.length = 0;
      frame.buffer.length = 0;
    }
    throw err;
  }

  // Knex resolves transaction() only after COMMIT succeeds. A callback
  // error or commit failure skips this block and discards both queues.
  const frame = transaction.frame;
  if (!frame) throw new Error("transactionContext: transaction frame missing");
  frame.state = "closed";
  flush(frame.buffer, deps.changeBus);
  await runAfterCommit(frame.afterCommit);
  frame.buffer.length = 0;
  frame.afterCommit.length = 0;
  frame.afterRollback.length = 0;
  return result;
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

async function runAfterCommit(
  callbacks: Array<() => Promise<void> | void>,
): Promise<void> {
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (err) {
      log.warn(
        `transactionContext: after-commit callback threw: ${String(err)}`,
      );
    }
  }
}

async function runAfterRollback(
  callbacks: Array<() => Promise<void> | void>,
): Promise<void> {
  for (let i = callbacks.length - 1; i >= 0; i--) {
    try {
      await callbacks[i]!();
    } catch (err) {
      log.warn(
        `transactionContext: rollback callback threw: ${String(err)}`,
      );
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
