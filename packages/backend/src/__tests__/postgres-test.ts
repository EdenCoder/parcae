import knexFactory, { type Knex } from 'knex';
import { describe, it } from 'vitest';

const url = process.env.PARCAE_TEST_DATABASE_URL;

export function describePostgres(name: string, factory: () => void): void {
  (url ? describe : describe.skip)(name, factory);
}

export function itPostgres(
  name: string,
  test: () => unknown | Promise<unknown>,
): void {
  (url ? it : it.skip)(name, test);
}

export interface PostgresTestDatabase {
  db: Knex;
  close(): Promise<void>;
}

export async function createPostgresTestDatabase(): Promise<PostgresTestDatabase> {
  if (!url) {
    throw new Error('PARCAE_TEST_DATABASE_URL is required for Postgres tests');
  }
  const schema = `parcae_test_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const admin = knexFactory({
    client: 'pg',
    connection: url,
    pool: { min: 0, max: 1 },
  });
  await admin.raw('CREATE SCHEMA ??', [schema]);
  const db = knexFactory({
    client: 'pg',
    connection: url,
    searchPath: [schema],
    pool: { min: 0, max: 2 },
  });

  return {
    db,
    async close() {
      await db.destroy();
      await admin.raw('DROP SCHEMA ?? CASCADE', [schema]);
      await admin.destroy();
    },
  };
}
