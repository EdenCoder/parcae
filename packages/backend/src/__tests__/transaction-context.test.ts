import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackendAdapter } from '../adapters/model';
import { clearHooks, hook } from '../routing/hook';
import {
  activeTransactionHandle,
  getActiveTransactionFrame,
  runAfterCommitIfActive,
  runAfterRollbackIfActive,
  withTransaction,
} from '../services/transactionContext';

function makeStubKnex() {
  const trx = { id: 'trx' };
  const transaction = vi.fn(async (fn: (handle: any) => Promise<any>) => {
    return await fn(trx);
  });
  return { transaction, trx };
}

function makeAdapterKnex(failCommit = false) {
  const committed = new Map<string, Record<string, any>>();
  const writes: string[] = [];

  const makeHandle = (
    rows: Map<string, Record<string, any>>,
    label: string,
  ): any => {
    const handle: any = (_table: string) => {
      let pending: Record<string, any> | null = null;
      let ids: string[] = [];
      let selected: string | null = null;
      const query: any = {
        insert(row: Record<string, any>) {
          pending = row;
          return query;
        },
        onConflict() {
          return query;
        },
        merge() {
          writes.push(label);
          rows.set(pending!.id, { ...pending! });
          return query;
        },
        async returning() {
          return [{ ...rows.get(pending!.id)! }];
        },
        where(column: string, value: string) {
          if (column === 'id') ids = [value];
          return query;
        },
        whereIn(column: string, values: readonly string[]) {
          if (column === 'id') ids = [...values];
          return query;
        },
        select(column: string) {
          selected = column;
          return query;
        },
        async first() {
          const row = rows.get(ids[0]!);
          return row && selected ? { [selected]: row[selected] } : row;
        },
        async increment(field: string, amount: number) {
          writes.push(label);
          for (const id of ids) {
            const row = rows.get(id);
            if (row) row[field] = Number(row[field] ?? 0) + amount;
          }
        },
        async decrement(field: string, amount: number) {
          writes.push(label);
          for (const id of ids) {
            const row = rows.get(id);
            if (row) row[field] = Number(row[field] ?? 0) - amount;
          }
        },
      };
      return query;
    };
    handle.raw = vi.fn(async () => undefined);
    return handle;
  };

  const knex = makeHandle(committed, 'root');
  knex.transaction = async (fn: (trx: any) => Promise<any>) => {
    const staged = new Map(
      [...committed].map(([id, row]) => [id, { ...row }] as const),
    );
    const trx = makeHandle(staged, 'trx');
    const result = await fn(trx);
    if (failCommit) throw new Error('commit failed');
    committed.clear();
    for (const [id, row] of staged) committed.set(id, row);
    return result;
  };

  return { knex, committed, writes };
}

const AdapterModel: any = {
  type: 'txitem',
  __schema: { name: 'string' },
};

function adapterModel(id: string): any {
  return {
    constructor: AdapterModel,
    id,
    __data: { id, name: id },
    __isNew: true,
  };
}

describe('withTransaction', () => {
  afterEach(() => clearHooks());

  it('publishes the active frame and transaction handle only inside the callback', async () => {
    const knex = makeStubKnex();
    expect(getActiveTransactionFrame()).toBeNull();
    expect(activeTransactionHandle()).toBeNull();

    await withTransaction({ knex }, async (trx) => {
      expect(trx).toBe(knex.trx);
      expect(getActiveTransactionFrame()?.state).toBe('active');
      expect(activeTransactionHandle()).toBe(knex.trx);
    });

    expect(getActiveTransactionFrame()).toBeNull();
    expect(activeTransactionHandle()).toBeNull();
  });

  it('reuses the outer transaction for nested calls', async () => {
    const knex = makeStubKnex();
    let outerFrame: unknown;
    let innerFrame: unknown;

    await withTransaction({ knex }, async (outer) => {
      outerFrame = getActiveTransactionFrame();
      await withTransaction({ knex }, async (inner) => {
        innerFrame = getActiveTransactionFrame();
        expect(inner).toBe(outer);
      });
    });

    expect(innerFrame).toBe(outerFrame);
    expect(knex.transaction).toHaveBeenCalledTimes(1);
  });

  it('runs commit callbacks after the database transaction resolves', async () => {
    const order: string[] = [];
    const knex = {
      transaction: async (fn: (trx: any) => Promise<any>) => {
        const result = await fn({});
        order.push('committed');
        return result;
      },
    };

    await withTransaction({ knex }, async () => {
      expect(
        runAfterCommitIfActive(() => {
          order.push('callback');
        }),
      ).toBe(true);
      order.push('body');
    });

    expect(order).toEqual(['body', 'committed', 'callback']);
  });

  it('runs rollback callbacks in reverse order and drops commit callbacks', async () => {
    const order: string[] = [];
    const knex = makeStubKnex();

    await expect(
      withTransaction({ knex }, async () => {
        runAfterRollbackIfActive(() => {
          order.push('first');
        });
        runAfterRollbackIfActive(() => {
          order.push('second');
        });
        runAfterCommitIfActive(() => {
          order.push('commit');
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(order).toEqual(['second', 'first']);
  });

  it.each([
    ['commit', false],
    ['rollback', true],
  ])('closes frames retained by detached work after %s', async (_label, rollback) => {
    const knex = makeStubKnex();
    let retained: ReturnType<typeof getActiveTransactionFrame> = null;
    let detached!: Promise<{
      frame: ReturnType<typeof getActiveTransactionFrame>;
      handle: any;
      afterCommit: boolean;
      afterRollback: boolean;
    }>;

    const transaction = withTransaction({ knex }, async () => {
      retained = getActiveTransactionFrame();
      detached = new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            frame: getActiveTransactionFrame(),
            handle: activeTransactionHandle(),
            afterCommit: runAfterCommitIfActive(() => {}),
            afterRollback: runAfterRollbackIfActive(() => {}),
          });
        }, 0);
      });
      if (rollback) throw new Error('rollback detached');
    });

    if (rollback) await expect(transaction).rejects.toThrow('rollback detached');
    else await transaction;
    const observed = await detached;

    expect((retained as { state: string } | null)?.state).toBe('closed');
    expect(observed).toEqual({
      frame: null,
      handle: null,
      afterCommit: false,
      afterRollback: false,
    });
  });

  it('rolls back adapter writes through the active handle', async () => {
    const db = makeAdapterKnex();
    const adapter = new BackendAdapter({ read: db.knex, write: db.knex });

    await expect(
      withTransaction({ knex: db.knex }, async () => {
        await adapter.save(adapterModel('rollback-write'));
        throw new Error('rollback adapter write');
      }),
    ).rejects.toThrow('rollback adapter write');

    expect(db.writes).toEqual(['trx']);
    expect(db.committed.has('rollback-write')).toBe(false);
  });

  it('runs operation cleanup when commit fails', async () => {
    const db = makeAdapterKnex(true);
    const adapter = new BackendAdapter({ read: db.knex, write: db.knex });
    const cleanup = vi.fn();
    hook.before(AdapterModel, 'create', ({ onError }: any) => onError(cleanup));

    await expect(adapter.save(adapterModel('failed-commit'))).rejects.toThrow(
      'commit failed',
    );

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(db.committed.has('failed-commit')).toBe(false);
  });

  it('rolls back when a synchronous after-hook fails', async () => {
    const db = makeAdapterKnex();
    const adapter = new BackendAdapter({ read: db.knex, write: db.knex });
    hook.after(AdapterModel, 'create', () => {
      throw new Error('after hook failed');
    });

    await expect(adapter.save(adapterModel('hook-rollback'))).rejects.toThrow(
      'after hook failed',
    );
    expect(db.committed.has('hook-rollback')).toBe(false);
  });

  it('runs counter writes inside transactions', async () => {
    const db = makeAdapterKnex();
    db.committed.set('one', { id: 'one', count: 5 });
    db.committed.set('two', { id: 'two', count: 7 });
    const adapter = new BackendAdapter({ read: db.knex, write: db.knex });
    const model = {
      constructor: AdapterModel,
      id: 'one',
      __data: { id: 'one', count: 5 },
      count: 5,
    };

    await adapter.increment(model, 'count', 2);
    await adapter.decrement(model, 'count', 1);
    await adapter.incrementMany(AdapterModel, ['one', 'two'], 'count', 3);

    expect(model.count).toBe(6);
    expect(db.committed.get('one')?.count).toBe(9);
    expect(db.committed.get('two')?.count).toBe(10);
    expect(db.writes).toEqual(['trx', 'trx', 'trx']);
  });
});
