/**
 * Transaction context — AsyncLocalStorage frame for `withTransaction(...)`.
 *
 * Postgres owns model-change delivery through transactional NOTIFY. This
 * context only coordinates the active Knex handle and commit/rollback side
 * effects used by hooks.
 *
 * Nested `withTransaction` calls share the outermost frame so a
 * rollback at the outer level discards every inner write — savepoint
 * semantics on top of the knex transaction API.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { log } from "../logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TransactionFrame {
  /** Knex transaction handle (`db.transaction()` provides it). */
  trx: any;
  /** Closed frames may remain visible to detached ALS work but are unusable. */
  state: "active" | "closed";
  /** Side effects that may run only after Knex confirms commit. */
  afterCommit: Array<() => Promise<void> | void>;
  /** Compensations that run if the outermost transaction fails. */
  afterRollback: Array<() => Promise<void> | void>;
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
}

/**
 * Run `fn` inside a knex transaction with a Parcae transaction frame.
 *
 * - Successful return → commit callbacks run.
 * - Thrown error → transaction rolls back and compensations run.
 * - Nested calls → share the outermost frame; inner commits don't flush.
 *
 * Example:
 * ```ts
 * await withTransaction({ knex: adapter.write }, async (trx) => {
 *   await Post.save({ ... }, { trx });
 *   await Tag.save({ ... }, { trx });
 *   // Postgres delivers both trigger notifications after commit.
 * });
 * ```
 */
export async function withTransaction<T>(
  deps: WithTransactionDeps,
  fn: (trx: any) => Promise<T>,
): Promise<T> {
  const existing = getActiveTransactionFrame();
  if (existing) {
    return await fn(existing.trx);
  }

  const transaction: { frame: TransactionFrame | null } = { frame: null };
  let result: T;
  try {
    result = await deps.knex.transaction(async (trx: any) => {
      transaction.frame = {
        trx,
        state: "active",
        afterCommit: [],
        afterRollback: [],
      };
      return await storage.run(transaction.frame, () => fn(trx));
    });
  } catch (err) {
    const frame = transaction.frame;
    if (frame) {
      frame.state = "closed";
      await runAfterRollback(frame.afterRollback);
      frame.afterRollback.length = 0;
      frame.afterCommit.length = 0;
    }
    throw err;
  }

  // Knex resolves transaction() only after COMMIT succeeds. A callback
  // error or commit failure skips this block and discards both queues.
  const frame = transaction.frame;
  if (!frame) throw new Error("transactionContext: transaction frame missing");
  frame.state = "closed";
  await runAfterCommit(frame.afterCommit);
  frame.afterCommit.length = 0;
  frame.afterRollback.length = 0;
  return result;
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
