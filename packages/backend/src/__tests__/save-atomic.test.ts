import { Model } from "@parcae/model";
import type { Knex } from "knex";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { BackendAdapter } from "../adapters/model";
import { clearHooks, hook } from "../routing/hook";
import {
  createPostgresTestDatabase,
  describePostgres,
  type PostgresTestDatabase,
} from "./postgres-test";

class AtomicRecord extends Model {
  static type = "atomicRecord" as const;
  title = "";
  items: string[] = [];
  profile: Record<string, string> = {};
  settings: Record<string, string> = {};
}

AtomicRecord.__schema = {
  title: "string",
  items: "json",
  profile: "json",
};

describePostgres("atomic save", () => {
  let database: PostgresTestDatabase;
  let db: Knex;
  let adapter: BackendAdapter;

  beforeEach(async () => {
    clearHooks();
    database = await createPostgresTestDatabase();
    db = database.db;
    await db.schema.createTable("atomicRecords", (table) => {
      table.string("id").primary();
      table.string("title");
      table.jsonb("items");
      table.jsonb("profile");
      table.dateTime("createdAt");
      table.dateTime("updatedAt");
      table.string("tmp");
      table.jsonb("data");
    });
    await db("atomicRecords").insert({
      id: "r1",
      title: "before",
      items: ["a", "b"],
      profile: { local: "before", remote: "before" },
      createdAt: new Date(0),
      updatedAt: new Date(0),
      tmp: null,
      data: { settings: { local: "before", remote: "before" } },
    });
    adapter = new BackendAdapter({ read: db, write: db });
  });

  afterEach(async () => {
    clearHooks();
    await database.close();
  });

  it("preserves unrelated concurrent scalar, JSONB, and overflow changes", async () => {
    const model = await adapter.findById(AtomicRecord, "r1");
    expect(model).not.toBeNull();
    model!.profile.local = "saved";
    model!.settings.local = "saved";

    await db("atomicRecords").where("id", "r1").update({
      title: "concurrent",
      profile: db.raw(
        `jsonb_set("profile", '{remote}', ?::jsonb, true)`,
        [JSON.stringify("concurrent")],
      ),
      data: db.raw(
        `jsonb_set("data", '{settings,remote}', ?::jsonb, true)`,
        [JSON.stringify("concurrent")],
      ),
    });

    await model!.save();

    const row = await db("atomicRecords").where("id", "r1").first();
    expect(row.title).toBe("concurrent");
    expect(row.profile).toEqual({ local: "saved", remote: "concurrent" });
    expect(row.data).toEqual({
      settings: { local: "saved", remote: "concurrent" },
    });
  });

  it("includes save-hook edits without dispatching patch hooks", async () => {
    const patchHook = vi.fn();
    hook.before(AtomicRecord, "save", ({ model }) => {
      model.profile.fromHook = "saved";
    });
    hook.before(AtomicRecord, "patch", patchHook);
    const model = await adapter.findById(AtomicRecord, "r1");

    await model!.save();

    const row = await db("atomicRecords").where("id", "r1").first();
    expect(row.profile.fromHook).toBe("saved");
    expect(patchHook).not.toHaveBeenCalled();
  });

  it("rejects a stale positional save after a concurrent array edit", async () => {
    const model = await adapter.findById(AtomicRecord, "r1");
    model!.items[1] = "saved";
    await db("atomicRecords").where("id", "r1").update({
      items: db.raw(`jsonb_insert("items", '{0}', ?::jsonb, false)`, [
        JSON.stringify("concurrent"),
      ]),
    });

    await expect(model!.save()).rejects.toMatchObject({ status: 409 });

    const row = await db("atomicRecords").where("id", "r1").first();
    expect(row.items).toEqual(["concurrent", "a", "b"]);
  });

  it("passes the authoritative merged row to after-save hooks", async () => {
    const seen: string[] = [];
    hook.after(AtomicRecord, "save", ({ model }) => {
      seen.push(model.title);
    });
    const model = await adapter.findById(AtomicRecord, "r1");
    model!.profile.local = "saved";
    await db("atomicRecords").where("id", "r1").update({
      title: "concurrent",
    });

    await model!.save();

    expect(seen).toEqual(["concurrent"]);
  });
});
