/**
 * Save hooks must see the PRE-save row in `model.__serverSnapshot` and
 * the post-edit state on the model itself — that before/after pair is
 * what set-diff hooks (counter sync, join-table maintenance, upstream
 * mirroring) run on.
 *
 * Regression: `_captureSaveModel` builds the hook-facing operation
 * model via `ModelClass.hydrate(post-edit data)`, and hydrate seeds
 * `__serverSnapshot` from the data it's given — so the snapshot
 * silently became the post-edit state and every server-side save-hook
 * diff was an empty no-op (join rows never created on a field
 * transition, counters never moved on save, mirroring never fired).
 */

import type { Knex } from "knex";
import { Model, type ModelAdapter } from "@parcae/model";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BackendAdapter } from "../adapters/model";
import { clearHooks, hook } from "../routing/hook";
import {
  createPostgresTestDatabase,
  describePostgres,
  type PostgresTestDatabase,
} from "./postgres-test";

class Snaptest extends Model {
  static override type = "snaptest";
  static override __schema = {
    title: "string" as const,
    members: "json" as const,
  };

  title = "";
  members: string[] = [];
}

describePostgres("save hooks — __serverSnapshot is the pre-save row", () => {
  let database: PostgresTestDatabase;
  let db: Knex;
  let adapter: BackendAdapter;

  beforeEach(async () => {
    clearHooks();
    database = await createPostgresTestDatabase();
    db = database.db;
    await db.schema.createTable("snaptests", (t) => {
      t.string("id").primary();
      t.string("title");
      t.jsonb("members");
      t.string("tmp");
      t.dateTime("createdAt");
      t.dateTime("updatedAt");
      t.jsonb("data");
    });
    adapter = new BackendAdapter({ read: db, write: db });
  });

  /** Insert the backing row a `hydrate()` call claims to have come from. */
  async function seed(id: string, members: string[]): Promise<void> {
    const now = new Date(0);
    await db("snaptests").insert({
      id,
      title: "t",
      members: JSON.stringify(members),
      createdAt: now,
      updatedAt: now,
      data: JSON.stringify({}),
    });
  }

  afterEach(async () => {
    clearHooks();
    await database.close();
  });

  it("after-save hook diffs pre-save snapshot against post-edit state", async () => {
    const seen: Array<{ before: string[]; after: string[] }> = [];

    hook.after(Snaptest, "save", ({ model }: any) => {
      seen.push({
        before: [...(model.__serverSnapshot?.members ?? [])],
        after: [...(model.members ?? [])],
      });
    });

    // Simulate the server-side flow: read the row, edit, save.
    await seed("s1", ["p1"]);
    const row = (await adapter.findById(Snaptest, "s1"))!;
    row.members = ["p1", "p2"];
    await adapter.save(row);

    expect(seen).toEqual([{ before: ["p1"], after: ["p1", "p2"] }]);
  });

  it("create dispatch does not inherit a phantom pre-save snapshot", async () => {
    const seen: Array<{ snapshot: string[]; current: string[] }> = [];

    // "save" registrations alias onto create — the hook fires, but its
    // snapshot must mirror the created state (empty diff), not [].
    hook.after(Snaptest, "save", ({ model }: any) => {
      seen.push({
        snapshot: [...(model.__serverSnapshot?.members ?? [])],
        current: [...(model.members ?? [])],
      });
    });

    // No backing row for a create, so this one can't come from
    // findById. boundary: `ModelAdapter.findById` is declared
    // `<T>(…) => Promise<T | null>` while BackendAdapter returns
    // `WithRefs<T>`, so BackendAdapter isn't assignable to
    // ModelAdapter — an upstream variance defect that expand.test.ts
    // and hook-onerror.test.ts hit at the same call shape.
    const row = Snaptest.hydrate(adapter as unknown as ModelAdapter, {
      id: "s2",
      title: "t",
      members: ["p1"],
    });
    row.__isNew = true;
    await adapter.save(row);

    expect(seen).toEqual([{ snapshot: ["p1"], current: ["p1"] }]);
  });

  it("second save on the same live model diffs against the refreshed snapshot", async () => {
    const seen: Array<{ before: string[]; after: string[] }> = [];

    hook.after(Snaptest, "save", ({ model }: any) => {
      seen.push({
        before: [...(model.__serverSnapshot?.members ?? [])],
        after: [...(model.members ?? [])],
      });
    });

    await seed("s3", []);
    const row = (await adapter.findById(Snaptest, "s3"))!;

    row.members = ["p1"];
    await row.save();
    row.members = ["p1", "p2"];
    await row.save();

    // Each save must diff only its own delta — a stale snapshot on the
    // second save would double-count p1.
    expect(seen).toEqual([
      { before: [], after: ["p1"] },
      { before: ["p1"], after: ["p1", "p2"] },
    ]);
  });
});
