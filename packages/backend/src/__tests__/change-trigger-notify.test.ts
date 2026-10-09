/**
 * End-to-end pin for the realtime contract: a RAW SQL write (no model,
 * no adapter, no manual emit) must reach a ChangeBus listener through
 * the installed Postgres trigger. Every consumer that deleted its
 * manual change fan-out is relying on exactly this path; the other
 * suites assert trigger DDL strings and feed the bus fake
 * notifications, so without this test the raw-write -> LISTEN ->
 * listener leg has no pin at all.
 */
import { afterAll, beforeAll, expect } from "vitest";
import { ChangeBus, type Change } from "../services/change-bus";
import { ensureChangeTriggers } from "../services/change-triggers";
import {
  createPostgresTestDatabase,
  describePostgres,
  itPostgres,
  type PostgresTestDatabase,
} from "./postgres-test";

const TABLE = `raw_write_probe_${Math.random().toString(36).slice(2, 8)}`;

function waitForChange(
  bus: ChangeBus,
  match: (change: Change) => boolean,
  timeoutMs = 5_000,
): Promise<Change> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("no change notification arrived"));
    }, timeoutMs);
    const unsubscribe = bus.on((change) => {
      if (!match(change)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(change);
    });
  });
}

describePostgres("change triggers — raw write to listener", () => {
  let pg: PostgresTestDatabase;
  let bus: ChangeBus;

  beforeAll(async () => {
    pg = await createPostgresTestDatabase();
    await pg.db.schema.createTable(TABLE, (t) => {
      t.string("id").primary();
      t.string("title");
    });
    await ensureChangeTriggers({ knex: pg.db, tables: [TABLE] });
    bus = new ChangeBus({
      url: process.env.PARCAE_TEST_DATABASE_URL as string,
    });
    await bus.start();
  });

  afterAll(async () => {
    await bus?.stop();
    await pg?.close();
  });

  itPostgres("delivers a raw INSERT to a bus subscriber", async () => {
    const arrival = waitForChange(
      bus,
      (c) => c.table === TABLE && c.op === "insert" && c.id === "row-1",
    );
    await pg.db(TABLE).insert({ id: "row-1", title: "first" });
    const change = await arrival;
    expect(change.changedFields).toEqual([]);
  });

  itPostgres("delivers a raw UPDATE with its changed fields", async () => {
    const arrival = waitForChange(
      bus,
      (c) => c.table === TABLE && c.op === "update" && c.id === "row-1",
    );
    await pg.db(TABLE).where({ id: "row-1" }).update({ title: "second" });
    const change = await arrival;
    expect(change.changedFields).toEqual(["title"]);
  });

  itPostgres("delivers a raw DELETE", async () => {
    const arrival = waitForChange(
      bus,
      (c) => c.table === TABLE && c.op === "delete" && c.id === "row-1",
    );
    await pg.db(TABLE).where({ id: "row-1" }).delete();
    await arrival;
  });

  itPostgres("leaks nothing from a rolled-back transaction", async () => {
    let sawRollbackRow = false;
    const unsubscribe = bus.on((c) => {
      if (c.table === TABLE && c.id === "rolled-back") sawRollbackRow = true;
    });
    await pg.db
      .transaction(async (trx) => {
        await trx(TABLE).insert({ id: "rolled-back", title: "never" });
        throw new Error("abort");
      })
      .catch(() => {});
    // A committed write afterwards proves the listener is still live
    // when we assert the rolled-back one never arrived.
    const arrival = waitForChange(
      bus,
      (c) => c.table === TABLE && c.id === "row-2",
    );
    await pg.db(TABLE).insert({ id: "row-2", title: "committed" });
    await arrival;
    unsubscribe();
    expect(sawRollbackRow).toBe(false);
  });
});
