/**
 * Integration tests for `.expand(...)` against a real SQLite-backed
 * BackendAdapter + RefLoader + subscription manager. The flow under
 * test is the production wire path:
 *
 *   1. Client builds `ProjectAsset.where(...).expand("file").find()`.
 *   2. Frontend records the steps and posts them to the LIST handler.
 *   3. The handler strips expand steps, replays the rest through
 *      `queryFromClient`, runs the SQL, then `hydrateExpansions`
 *      embeds the linked File rows in the wire payload — batched
 *      through `RefLoader` (one `WHERE id IN (...)` for all files).
 *   4. The wire payload carries `{ file: { ... }, $file: "f_xyz" }`.
 *   5. The frontend `Model.hydrate` keeps the inline ref object so
 *      `asset.file.url` reads are synchronous.
 *
 * Subscription path additions:
 *
 *   6. A subscriber to the same query with `.expand("file")` gets
 *      the embedded shape in its cached items.
 *   7. Writing a `File` row wakes every subscriber that expanded
 *      it, regardless of which parent type they were subscribed
 *      against (v1 naive invalidation; see DOL-1093).
 *
 * Tests run against an in-memory SQLite DB with a minimal
 * Asset + File pair — same schema shape as Dollhouse's
 * ProjectAsset.file → File ref the screenshot was attacking.
 */

import knexFactory, { type Knex } from "knex";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { Model } from "@parcae/model";
import { BackendAdapter } from "../adapters/model";
import { RefLoader } from "../services/ref-loader";
import { runWithRequestContext } from "../services/context";
import {
  hydrateExpansions,
  parseExpandSpecs,
  validateExpandSpecs,
} from "../services/hydrate-expansions";
import { QuerySubscriptionManager } from "../services/subscriptions";

// ─── Fixture ─────────────────────────────────────────────────────────────────

class FileM extends Model {
  static override type = "file";
  static override __schema = {
    url: "string",
    mime: "string",
    bytes: "number",
  } as any;
  url: string = "";
  mime: string = "";
  bytes: number = 0;
}

class AssetM extends Model {
  static override type = "asset";
  // `file` MUST be a ref so `validateExpandSpecs` accepts the
  // `.expand("file")` request. `kind` is a plain column so we can
  // also verify non-ref fields are rejected from expand.
  static override __schema = {
    kind: "string",
    file: { kind: "ref", target: FileM },
  } as any;
  kind: string = "";
}

function sqlite(): Knex {
  return knexFactory({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
  });
}

async function makeAdapter(db: Knex): Promise<BackendAdapter> {
  const adapter = new (BackendAdapter as any)({ read: db, write: db });
  await adapter.detectEngine("sqlite");
  (adapter as any).registerModels([FileM, AssetM]);
  await adapter.ensureAllTables([FileM, AssetM]);
  return adapter as BackendAdapter;
}

const REGISTRY: ReadonlyMap<string, any> = new Map<string, any>([
  ["file", FileM],
  ["asset", AssetM],
]);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("expand — integration through BackendAdapter + RefLoader", () => {
  let db: Knex;
  let adapter: BackendAdapter;

  beforeEach(async () => {
    db = sqlite();
    adapter = await makeAdapter(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("embeds the linked File row in the LIST payload in ONE batched query", async () => {
    // Seed: 5 files, 5 assets each referencing one.
    const fileRows = [
      { id: "f1", data: "{}", url: "https://cdn/1", mime: "image/png", bytes: 0 },
      { id: "f2", data: "{}", url: "https://cdn/2", mime: "image/png", bytes: 0 },
      { id: "f3", data: "{}", url: "https://cdn/3", mime: "image/png", bytes: 0 },
      { id: "f4", data: "{}", url: "https://cdn/4", mime: "image/png", bytes: 0 },
      { id: "f5", data: "{}", url: "https://cdn/5", mime: "image/png", bytes: 0 },
    ];
    await db("files").insert(fileRows);
    await db("assets").insert([
      { id: "a1", data: "{}", kind: "image", file: "f1" },
      { id: "a2", data: "{}", kind: "image", file: "f2" },
      { id: "a3", data: "{}", kind: "image", file: "f3" },
      { id: "a4", data: "{}", kind: "image", file: "f4" },
      { id: "a5", data: "{}", kind: "image", file: "f5" },
    ]);

    // The route handler's flow, condensed: peel expand → query →
    // sanitize → hydrate. The RefLoader has to be on the request
    // scope for `findById` batching; for `hydrateExpansions` we pass
    // it explicitly (the route handler does the same).
    const sql: string[] = [];
    db.on("query", ({ sql: s }: { sql: string }) => sql.push(s));

    const refLoader = new RefLoader((type, ids) =>
      adapter.batchFindByType(type, ids),
    );
    await runWithRequestContext(
      { user: null, refLoader },
      async () => {
        // Validate + resolve expand. (parse is pure, validate hits
        // the registry.)
        const expand = validateExpandSpecs(
          parseExpandSpecs(["file"]),
          AssetM as any,
          REGISTRY as Map<string, any>,
        );
        // Run the SQL query.
        const items = await adapter.query(AssetM).find();
        // Sanitize to wire shape (mirrors `projectForWire`).
        const wireItems = await Promise.all(
          items.map((m: any) => m.sanitize()),
        );
        // Hydrate expansions in place.
        await hydrateExpansions(wireItems, expand, refLoader, null);

        // Each row got the embedded File.
        for (const row of wireItems) {
          expect(row.file).toMatchObject({
            type: "file",
            url: expect.stringMatching(/^https:\/\/cdn\//),
          });
          // The raw id is preserved as $<ref> per the DOL-148 contract.
          expect(row.$file).toBe(row.file.id);
        }

        // Exactly ONE batched `SELECT … WHERE "id" in (?, ?, ?, ?, ?)`
        // — the whole point. Before .expand(), this was 5 separate
        // `WHERE id = ?` round-trips.
        const fileLookups = sql.filter((s) =>
          /from\s+["`]?files["`]?/i.test(s) && /\bin\s*\(/i.test(s),
        );
        expect(fileLookups).toHaveLength(1);
      },
    );
  });

  it("rejects expand on a non-ref field with a ClientError", () => {
    expect(() =>
      validateExpandSpecs(
        parseExpandSpecs(["kind"]),
        AssetM as any,
        REGISTRY as Map<string, any>,
      ),
    ).toThrow(/not a ref field/);
  });

  it("rejects expand on an unknown column", () => {
    expect(() =>
      validateExpandSpecs(
        parseExpandSpecs(["nonexistent"]),
        AssetM as any,
        REGISTRY as Map<string, any>,
      ),
    ).toThrow(/not a ref field/);
  });

  it("rejects projecting an unknown target column", () => {
    expect(() =>
      validateExpandSpecs(
        parseExpandSpecs(["file.wat"]),
        AssetM as any,
        REGISTRY as Map<string, any>,
      ),
    ).toThrow(/not a column on file/);
  });

  it("Model.hydrate(...) keeps an inline expanded ref", () => {
    // Same shape the LIST handler produces post-hydrateExpansions:
    // the wire row has `file: { id, type, url, ... }` AND `$file: id`.
    // The frontend keeps the inline row so `asset.file.url` is synchronous.
    const asset = AssetM.hydrate(adapter, {
      id: "a1",
      kind: "image",
      file: {
        id: "f1",
        type: "file",
        url: "https://cdn/1.png",
        mime: "image/png",
        bytes: 0,
      },
      $file: "f1",
    });
    // Synchronous with no second lookup.
    expect((asset as any).file.url).toBe("https://cdn/1.png");
    expect((asset as any).$file).toBe("f1");
  });
});

// ─── Subscription manager ────────────────────────────────────────────────────

describe("expand — subscription manager integration", () => {
  let db: Knex;
  let adapter: BackendAdapter;
  let manager: QuerySubscriptionManager;
  let emitted: Array<{ socketId: string; event: string; data: any }>;

  beforeEach(async () => {
    db = sqlite();
    adapter = await makeAdapter(db);
    emitted = [];
    manager = new QuerySubscriptionManager(
      (socketId, event, data) => emitted.push({ socketId, event, data }),
      // Drop the coalesce windows so onModelChange → reeval fires
      // immediately for assertion purposes (same trick the existing
      // subscriptions.test.ts uses).
      { debounceMs: 0, maxWaitMs: 0 },
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("subscription with .expand('file') ships embedded File rows in the initial items", async () => {
    await db("files").insert({
      id: "f1",
      data: "{}",
      url: "https://cdn/1",
      mime: "image/png",
      bytes: 0,
    });
    await db("assets").insert({ id: "a1", data: "{}", kind: "image", file: "f1" });

    const expand = validateExpandSpecs(
      parseExpandSpecs(["file"]),
      AssetM as any,
      REGISTRY as Map<string, any>,
    );

    const sub = await manager.subscribe({
      socketId: "s1",
      query: adapter.query(AssetM),
      expand,
    });

    expect(sub.items).toHaveLength(1);
    expect(sub.items[0]!.file).toMatchObject({
      type: "file",
      id: "f1",
      url: "https://cdn/1",
    });
    expect(sub.items[0]!.$file).toBe("f1");
  });

  it("subscriptions with different expand shapes hash to different cache entries", async () => {
    await db("files").insert({
      id: "f1",
      data: "{}",
      url: "https://cdn/1",
      mime: "image/png",
      bytes: 0,
    });
    await db("assets").insert({ id: "a1", data: "{}", kind: "image", file: "f1" });

    const withExpand = await manager.subscribe({
      socketId: "s1",
      query: adapter.query(AssetM),
      expand: validateExpandSpecs(
        parseExpandSpecs(["file"]),
        AssetM as any,
        REGISTRY as Map<string, any>,
      ),
    });
    const withoutExpand = await manager.subscribe({
      socketId: "s2",
      query: adapter.query(AssetM),
    });

    // Different shape → different hash → different cached query.
    expect(withExpand.hash).not.toBe(withoutExpand.hash);
    // The expanded subscriber gets the embedded shape; the bare
    // subscriber gets the raw id.
    expect(typeof withExpand.items[0]!.file).toBe("object");
    expect(typeof withoutExpand.items[0]!.file).toBe("string");
  });

  it("changing a File row wakes subscribers that expanded `file`", async () => {
    await db("files").insert({
      id: "f1",
      data: "{}",
      url: "https://cdn/before",
      mime: "image/png",
      bytes: 0,
    });
    await db("assets").insert({ id: "a1", data: "{}", kind: "image", file: "f1" });

    const expand = validateExpandSpecs(
      parseExpandSpecs(["file"]),
      AssetM as any,
      REGISTRY as Map<string, any>,
    );
    await manager.subscribe({
      socketId: "s1",
      query: adapter.query(AssetM),
      expand,
    });

    // No emits yet — initial subscribe doesn't notify.
    expect(emitted).toHaveLength(0);

    // Mutate the File row directly. Then simulate the change-bus
    // wake (the production path fires this on every `updatedAt`
    // bump or successful save).
    await db("files").update({ url: "https://cdn/after" }).where({ id: "f1" });
    manager.onModelChange("file");

    // Wait for the (debounceMs=0) re-eval cycle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The subscriber got a delta with the new url embedded.
    expect(emitted.length).toBeGreaterThan(0);
    const last = emitted[emitted.length - 1]!;
    expect(last.event).toMatch(/^query:/);
    const ops = (last.data as { ops: Array<{ op: string; patch?: any[] }> }).ops;
    expect(ops.length).toBeGreaterThan(0);
    // The change shows up as a patch op against `/file/url`.
    const updateOp = ops.find((o) => o.op === "update");
    expect(updateOp).toBeDefined();
    const urlOp = updateOp!.patch!.find(
      (p: { path: string }) => p.path === "/file/url",
    );
    expect(urlOp).toBeDefined();
    expect((urlOp as { value: string }).value).toBe("https://cdn/after");
  });
});
