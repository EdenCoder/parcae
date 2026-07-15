import knexFactory, { type Knex } from 'knex';
import { describe } from 'vitest';

const baseUrl = process.env.PARCAE_TEST_DATABASE_URL;

export function describePostgres(name: string, factory: () => void): void {
  (baseUrl ? describe : describe.skip)(name, factory);
}

export async function createPostgresTestDatabase(): Promise<{
  db: Knex;
  url: string;
  close(): Promise<void>;
}> {
  if (!baseUrl) throw new Error('PARCAE_TEST_DATABASE_URL is required');
  const schema = `parcae_test_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const admin = knexFactory({ client: 'pg', connection: baseUrl });
  await admin.raw('CREATE SCHEMA ??', [schema]);
  const parsed = new URL(baseUrl);
  parsed.searchParams.set('options', `-c search_path=${schema}`);
  const url = parsed.toString();
  const db = knexFactory({ client: 'pg', connection: url });
  return {
    db,
    url,
    async close() {
      await db.destroy();
      await admin.raw('DROP SCHEMA ?? CASCADE', [schema]);
      await admin.destroy();
    },
  };
}
