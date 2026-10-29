/**
 * Tests for `QueryChain.update()` — the bulk UPDATE terminal.
 *
 * One SQL statement updates every matched row: schema columns set
 * directly, unknown keys merged into the `data` JSONB overflow,
 * `updatedAt` stamped, system fields rejected, and no per-row model
 * hydration or save hooks. The statement runs on the write pool with
 * the chain's filters folded in as an id-subquery, which also makes
 * `.orderBy().limit().update()` work ("update the N stalest rows").
 *
 * Runs against isolated Postgres schemas like the other adapter tests.
 */

import type { Knex } from 'knex';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BackendAdapter } from '../adapters/model';
import {
  createPostgresTestDatabase,
  describePostgres,
  type PostgresTestDatabase,
} from './postgres-test';

const JobModel: any = {
  type: 'job',
  __schema: {
    title: 'string',
    lockedAt: 'datetime',
    meta: 'json',
  },
  indexes: [],
};

const TABLE = 'jobs';

async function makeAdapter(db: Knex): Promise<BackendAdapter> {
  const adapter = new (BackendAdapter as any)({ read: db, write: db });
  await adapter.detectEngine();
  await adapter.ensureAllTables([JobModel]);
  return adapter as BackendAdapter;
}

async function seed(db: Knex): Promise<void> {
  const old = new Date('2024-01-01T00:00:00Z');
  await db(TABLE).insert([
    {
      id: 'a',
      title: 'stuck one',
      lockedAt: new Date('2024-01-01T01:00:00Z'),
      createdAt: old,
      updatedAt: old,
      data: JSON.stringify({ keep: 'me' }),
    },
    {
      id: 'b',
      title: 'stuck two',
      lockedAt: new Date('2024-01-02T01:00:00Z'),
      createdAt: old,
      updatedAt: old,
      data: JSON.stringify({}),
    },
    {
      id: 'c',
      title: 'idle',
      lockedAt: null,
      createdAt: old,
      updatedAt: old,
      data: JSON.stringify({}),
    },
  ]);
}

describePostgres('QueryChain.update — bulk UPDATE terminal', () => {
  let database: PostgresTestDatabase;
  let db: Knex;
  let adapter: BackendAdapter;

  beforeEach(async () => {
    database = await createPostgresTestDatabase();
    db = database.db;
    adapter = await makeAdapter(db);
    await seed(db);
  });

  afterEach(async () => {
    await database.close();
  });

  it('updates every matched row in one statement and returns the count', async () => {
    const n = await adapter.query(JobModel).whereNotNull('lockedAt').update({ lockedAt: null });
    expect(n).toBe(2);

    const rows = await db(TABLE).orderBy('id');
    expect(rows.map((r: any) => r.lockedAt)).toEqual([null, null, null]);
  });

  it('rechecks guarded rows after a concurrent write and stamps only matched rows', async () => {
    const before = await db(TABLE).orderBy('id');
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = adapter.runInTransaction(async (trx) => {
      const count = await adapter
        .query(JobModel)
        .whereNotNull('lockedAt')
        .update({ lockedAt: null, title: 'first receipt' });
      entered();
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const { rows } = await trx.raw(`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks
            WHERE NOT granted AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
          ) AS waiting
        `);
        waiting = rows[0].waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      return count;
    });
    await started;
    const second = adapter
      .query(JobModel)
      .whereNotNull('lockedAt')
      .update({ lockedAt: null, title: 'second receipt' });
    expect(await Promise.all([first, second])).toEqual([2, 0]);
    const after = await db(TABLE).orderBy('id');

    expect(after.slice(0, 2).map((row) => row.title)).toEqual(['first receipt', 'first receipt']);
    expect(after[0].updatedAt).not.toEqual(before[0].updatedAt);
    expect(after[1].updatedAt).not.toEqual(before[1].updatedAt);
    expect(after[2]).toEqual(before[2]);
  });

  it('applies distinct sparse patches without changing other fields or rows outside the query', async () => {
    await db(TABLE).where({ id: 'b' }).update({ data: null });
    const before = await db(TABLE).orderBy('id');
    const n = await adapter
      .query(JobModel)
      .whereIn('id', ['a', 'b'])
      .update([
        { id: 'a', meta: { resolution: '4k' }, flagged: true },
        { id: 'b', title: 'retained', lockedAt: null },
        { id: 'c', title: 'outside the query' },
      ]);
    expect(n).toBe(2);

    const rows = await db(TABLE).orderBy('id');
    expect(rows[0]).toMatchObject({
      title: before[0].title,
      lockedAt: before[0].lockedAt,
      meta: { resolution: '4k' },
      data: { keep: 'me', flagged: true },
    });
    expect(rows[1]).toMatchObject({ title: 'retained', lockedAt: null, data: null });
    expect(rows[2]).toEqual(before[2]);
  });

  it('supports orderBy + limit via the id-subquery shape', async () => {
    const n = await adapter
      .query(JobModel)
      .whereNotNull('lockedAt')
      .orderBy('lockedAt', 'asc')
      .limit(1)
      .update({ title: 'oldest stuck' });
    expect(n).toBe(1);

    const rows = await db(TABLE).orderBy('id');
    expect(rows[0].title).toBe('oldest stuck'); // "a" has the older lockedAt
    expect(rows[1].title).toBe('stuck two');
  });

  it('rejects system fields and empty patches', async () => {
    const chain = adapter.query(JobModel).where({ id: 'a' });
    await expect(chain.update({})).rejects.toThrow(/non-empty/);
    for (const key of ['id', 'createdAt', 'updatedAt', 'type', 'tmp']) {
      await expect(chain.update({ [key]: 'x' })).rejects.toThrow(/system field/);
    }
    // Nothing was written by the rejected attempts.
    const row: any = await db(TABLE).where({ id: 'a' }).first();
    expect(row.title).toBe('stuck one');
  });
});
