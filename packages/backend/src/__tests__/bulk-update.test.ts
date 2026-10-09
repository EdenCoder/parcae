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

import type { Knex } from "knex";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BackendAdapter } from "../adapters/model";
import {
  createPostgresTestDatabase,
  describePostgres,
  type PostgresTestDatabase,
} from "./postgres-test";

const JobModel: any = {
  type: "job",
  __schema: {
    title: "string",
    lockedAt: "datetime",
    meta: "json",
  },
  indexes: [],
};

const TABLE = "jobs";

async function makeAdapter(db: Knex): Promise<BackendAdapter> {
  const adapter = new (BackendAdapter as any)({ read: db, write: db });
  await adapter.detectEngine();
  await adapter.ensureAllTables([JobModel]);
  return adapter as BackendAdapter;
}

async function seed(db: Knex): Promise<void> {
  const old = new Date("2024-01-01T00:00:00Z");
  await db(TABLE).insert([
    {
      id: "a",
      title: "stuck one",
      lockedAt: new Date("2024-01-01T01:00:00Z"),
      createdAt: old,
      updatedAt: old,
      data: JSON.stringify({ keep: "me" }),
    },
    {
      id: "b",
      title: "stuck two",
      lockedAt: new Date("2024-01-02T01:00:00Z"),
      createdAt: old,
      updatedAt: old,
      data: JSON.stringify({}),
    },
    {
      id: "c",
      title: "idle",
      lockedAt: null,
      createdAt: old,
      updatedAt: old,
      data: JSON.stringify({}),
    },
  ]);
}

describePostgres("QueryChain.update — bulk UPDATE terminal", () => {
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

  it("updates every matched row in one statement and returns the count", async () => {
    const n = await adapter
      .query(JobModel)
      .whereNotNull("lockedAt")
      .update({ lockedAt: null });
    expect(n).toBe(2);

    const rows = await db(TABLE).orderBy("id");
    expect(rows.map((r: any) => r.lockedAt)).toEqual([null, null, null]);
  });

  it("stamps updatedAt on matched rows and leaves others untouched", async () => {
    const before = await db(TABLE).orderBy("id");
    await adapter
      .query(JobModel)
      .whereNotNull("lockedAt")
      .update({ lockedAt: null });
    const after = await db(TABLE).orderBy("id");

    expect(after[0].updatedAt).not.toEqual(before[0].updatedAt);
    expect(after[1].updatedAt).not.toEqual(before[1].updatedAt);
    // Row "c" didn't match — completely untouched.
    expect(after[2]).toEqual(before[2]);
  });

  it("serializes json columns and merges unknown keys into the data overflow", async () => {
    const n = await adapter
      .query(JobModel)
      .where({ id: "a" })
      .update({ meta: { resolution: "4k" }, flagged: true });
    expect(n).toBe(1);

    const row: any = await db(TABLE).where({ id: "a" }).first();
    expect(row.meta).toEqual({ resolution: "4k" });
    // Overflow merge preserves pre-existing overflow keys.
    expect(row.data).toEqual({ keep: "me", flagged: true });
  });

  it("supports orderBy + limit via the id-subquery shape", async () => {
    const n = await adapter
      .query(JobModel)
      .whereNotNull("lockedAt")
      .orderBy("lockedAt", "asc")
      .limit(1)
      .update({ title: "oldest stuck" });
    expect(n).toBe(1);

    const rows = await db(TABLE).orderBy("id");
    expect(rows[0].title).toBe("oldest stuck"); // "a" has the older lockedAt
    expect(rows[1].title).toBe("stuck two");
  });

  it("rejects system fields and empty patches", async () => {
    const chain = adapter.query(JobModel).where({ id: "a" });
    await expect(chain.update({})).rejects.toThrow(/non-empty/);
    for (const key of ["id", "createdAt", "updatedAt", "type", "tmp"]) {
      await expect(chain.update({ [key]: "x" })).rejects.toThrow(
        /system field/,
      );
    }
    // Nothing was written by the rejected attempts.
    const row: any = await db(TABLE).where({ id: "a" }).first();
    expect(row.title).toBe("stuck one");
  });
});
