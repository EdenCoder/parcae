/**
 * SQL adapter patch-vivification tests — DOL-553.
 *
 * `_ensureIntermediates` walks every parent depth of a JSON-Pointer
 * path and emits one `jsonb_set_lax` ensuring that intermediate
 * exists. For each intermediate, the default JSONB shape used when
 * the existing value is null/missing must depend on the NEXT path
 * segment:
 *
 *   - numeric index ("0", "12") or `-` → `'[]'::jsonb`
 *   - any other key                    → `'{}'::jsonb`
 *
 * Without the array branch, a sub-path patch (e.g. from a hook
 * doing `replace /blocks/<id>/shots/0/panel`) on a row with no
 * prior `shots` field would write `shots = { "0": { panel: … } }`,
 * passing the JSON write but blowing up every subsequent
 * `for (const s of block.shots)` once the row hydrates back into
 * JS.
 *
 * These tests intercept `knex.raw(sql, bindings)` and assert on the
 * SQL strings actually emitted. No real database is involved — the
 * SQL builder layer is the unit of test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import knexFactory from "knex";
import { BackendAdapter } from "../adapters/model";
import { clearHooks } from "../routing/hook";

// ─── Recording knex stub ────────────────────────────────────────────────────

interface RawCall {
  sql: string;
  bindings: any[];
}

interface UpdateCall {
  table: string;
  whereCol: string;
  whereVal: unknown;
  fields: Record<string, unknown>;
}

interface KnexCapture {
  raws: RawCall[];
  updates: UpdateCall[];
  /**
   * Combined SQL for the most recent update on a column (joined raw
   * fragments). Convenience for asserting on the final emitted SQL
   * shape per column.
   */
  lastSqlFor: (column: string) => string | undefined;
  lastBindingsFor: (column: string) => any[] | undefined;
  setRow: (row: Record<string, any>) => void;
}

/**
 * A function that doubles as a "knex(table)" query-builder factory
 * AND carries a `.raw(sql, bindings)` member. Mirrors knex's actual
 * call shape (`knex(table).where(...).update(fields)` and
 * `knex.raw(sql, bindings)`). Captures every `raw` call and the
 * fields handed to `update`, so the test can inspect what the
 * adapter built without ever touching a real DB.
 */
function createKnexStub(): {
  knex: any;
  capture: KnexCapture;
} {
  const raws: RawCall[] = [];
  const updates: UpdateCall[] = [];
  let currentRow: Record<string, any> = {
    id: "p1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    data: {},
  };

  // Tag returned from raw() so update() can recognise its own raws
  // and (for the test) extract the sql + bindings.
  type Raw = { __raw: true; sql: string; bindings: any[] };

  const knex: any = (table: string) => {
    let whereCol = "";
    let whereVal: unknown = undefined;
    return {
      where(col: string, val: unknown) {
        whereCol = col;
        whereVal = val;
        return this;
      },
      forUpdate() {
        return this;
      },
      async first() {
        return currentRow;
      },
      update(fields: Record<string, unknown>) {
        // Resolve raw() values into a plain {sql, bindings} record
        // so the test can assert on what was actually compiled.
        const resolved: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) {
          if (v && typeof v === "object" && (v as Raw).__raw) {
            const r = v as Raw;
            resolved[k] = { sql: r.sql, bindings: r.bindings };
          } else {
            resolved[k] = v;
          }
        }
        updates.push({ table, whereCol, whereVal, fields: resolved });
        currentRow = { ...currentRow, id: whereVal as string };
        for (const [key, value] of Object.entries(fields)) {
          if (!value || typeof value !== "object" || !(value as Raw).__raw) {
            currentRow[key] = value;
          }
        }
        return {
          returning: async () => [{ ...currentRow }],
        };
      },
    };
  };

  knex.raw = (sql: string, bindings: any[] = []) => {
    raws.push({ sql, bindings });
    return { __raw: true, sql, bindings } as Raw;
  };
  knex.transaction = async (fn: (trx: any) => Promise<any>) => fn(knex);

  // The patch path doesn't run schema introspection, but a couple
  // of code paths read `engine` / `pubsub` off the adapter — leave
  // them undefined and set engine explicitly per test.
  return {
    knex,
    capture: {
      raws,
      updates,
      lastSqlFor(column: string) {
        const last = [...updates].reverse().find((u) =>
          column in u.fields,
        );
        if (!last) return undefined;
        const v = last.fields[column];
        if (v && typeof v === "object" && "sql" in (v as any)) {
          return (v as any).sql as string;
        }
        return typeof v === "string" ? v : undefined;
      },
      lastBindingsFor(column: string) {
        const last = [...updates].reverse().find((u) =>
          column in u.fields,
        );
        if (!last) return undefined;
        const v = last.fields[column];
        if (v && typeof v === "object" && "bindings" in (v as any)) {
          return (v as any).bindings as any[];
        }
        return undefined;
      },
      setRow(row: Record<string, any>) {
        currentRow = { ...row };
      },
    },
  };
}

// ─── Test model ─────────────────────────────────────────────────────────────

/**
 * The JSON column under test. Schema declares it as `json`, so the
 * adapter routes patches against `/blocks/...` to the JSONB SQL
 * branch (the one with `_ensureIntermediates`).
 */
const ProjectModel: any = {
  type: "project",
  __schema: {
    blocks: "json",
    tags: "json",
    meta: "json",
    camelCase: "json",
    title: "string",
  },
  hydrate(_adapter: BackendAdapter, data: Record<string, any>) {
    return { __data: data };
  },
};

function makeModel(id = "p1", initialBlocks: any = {}): any {
  return {
    constructor: ProjectModel,
    id,
    __data: { id, blocks: initialBlocks, tags: [], meta: {} },
    // DOL-675: `_patchPostgres` reads `__serverSnapshot[column]` to
    // decide which intermediate `jsonb_set_lax` ensures can be
    // skipped. Mirror the in-memory blocks so tests that exercise
    // the skip path see the same shape.
    __serverSnapshot: { id, blocks: initialBlocks, tags: [], meta: {} },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("BackendAdapter._patchPostgres — vivification shape (DOL-553)", () => {
  let adapter: BackendAdapter;
  let capture: KnexCapture;

  beforeEach(() => {
    clearHooks();
    const stub = createKnexStub();
    adapter = new BackendAdapter({ read: stub.knex, write: stub.knex });
    adapter.engine = "postgres";
    capture = stub.capture;
  });

  afterEach(() => {
    clearHooks();
  });

  // ── Numeric next-segment → array intermediate ─────────────────────

  it("emits '[]'::jsonb for an intermediate whose next segment is a numeric index", async () => {
    const model = makeModel();
    await adapter.patch(model, [
      {
        op: "replace",
        path: "/blocks/abc/shots/0/panel",
        value: { url: "https://example.test/p.png" },
      } as any,
    ]);
    const sql = capture.lastSqlFor("blocks");
    expect(sql).toBeDefined();
    // The intermediate at depth 2 (`blocks.abc.shots`) — the one
    // whose next segment is "0" — must default to '[]'::jsonb.
    expect(sql).toContain("'[]'::jsonb");
    // There should also be at least one '{}'::jsonb (for the
    // intermediate at depth 1: `blocks.abc`, whose next segment
    // is "shots").
    expect(sql).toContain("'{}'::jsonb");
  });

  it("emits '[]'::jsonb when the path uses the RFC 6901 append marker", async () => {
    const model = makeModel();
    await adapter.patch(model, [
      {
        op: "add",
        path: "/blocks/abc/shots/-",
        value: { id: "s1", setup: "WIDE" },
      } as any,
    ]);
    const sql = capture.lastSqlFor("blocks");
    expect(sql).toBeDefined();
    // The append branch hardcodes '[]'::jsonb in its emit callback;
    // confirm the SQL still carries it (regression — the static
    // default for `-` was preserved by the DOL-553 refactor).
    expect(sql).toContain("'[]'::jsonb");
  });

  // ── Non-numeric next-segment → object intermediate ────────────────

  it("emits '{}'::jsonb for an intermediate whose next segment is a string key", async () => {
    const model = makeModel();
    await adapter.patch(model, [
      {
        op: "replace",
        path: "/blocks/abc/portrait/url",
        value: "https://example.test/p.png",
      } as any,
    ]);
    const sql = capture.lastSqlFor("blocks");
    expect(sql).toBeDefined();
    // Every intermediate here should be `{}` — none of the
    // segments after the first are numeric.
    expect(sql).toContain("'{}'::jsonb");
    expect(sql).not.toContain("'[]'::jsonb");
  });

  it("mixes '[]'::jsonb and '{}'::jsonb correctly along the same path", async () => {
    const model = makeModel();
    await adapter.patch(model, [
      {
        op: "replace",
        path: "/blocks/abc/shots/0/meta/inner",
        value: "v",
      } as any,
    ]);
    const sql = capture.lastSqlFor("blocks");
    expect(sql).toBeDefined();
    // Counts of each default — depths 1..len-1:
    //   depth 1: nextSeg = "abc"  → {}
    //   depth 2: nextSeg = "shots" → {}
    //   depth 3: nextSeg = "0"     → []  ← the array container
    //   depth 4: nextSeg = "meta"  → {}
    //   depth 5: nextSeg = "inner" → {}
    const arrayCount = (sql!.match(/'\[\]'::jsonb/g) ?? []).length;
    const objectCount = (sql!.match(/'\{\}'::jsonb/g) ?? []).length;
    expect(arrayCount).toBe(1);
    // Top-level COALESCE adds one extra '{}'::jsonb wrapping the
    // column itself, plus one per intermediate emit (4 here).
    expect(objectCount).toBeGreaterThanOrEqual(4);
  });

  // ── Dedupe: same intermediate ensured once across multiple ops ────

  it("ensures each intermediate exactly once across multiple ops on the same column", async () => {
    const model = makeModel();
    await adapter.patch(model, [
      {
        op: "replace",
        path: "/blocks/abc/shots/0/panel",
        value: { url: "u1" },
      } as any,
      {
        op: "replace",
        path: "/blocks/abc/shots/1/panel",
        value: { url: "u2" },
      } as any,
    ]);
    const sql = capture.lastSqlFor("blocks");
    expect(sql).toBeDefined();
    // The shared parents (`blocks.abc` → {}, `blocks.abc.shots` →
    // []) should each be ensured exactly once even though both
    // ops walk the same chain.
    const arrayCount = (sql!.match(/'\[\]'::jsonb/g) ?? []).length;
    expect(arrayCount).toBe(1);
  });

  // ── DOL-675: ensure pass must NOT undo prior remove ops ──────────

  it("does not undo a remove sibling when a replace ensures the same parent", async () => {
    // Pre-state: block b119 with three shots. We remove two of the
    // three and update the third's `order` field. The replace's
    // `_ensureIntermediates` walk MUST NOT re-read
    // `column #> '{b119}'` (and thereby resurrect the removed shots
    // by setting `b119` back to its original value). Pre-fix: the
    // ensure read from `column` and silently undid the removes.
    const model = makeModel("p1", {
      b119: {
        shots: {
          b120: { id: "b120", setup: "MED", order: "a0" },
          b443: { id: "b443", setup: "OTS", order: "a1" },
          b550: { id: "b550", setup: "WIDE", order: "a2" },
        },
      },
    });
    await adapter.patch(model, [
      { op: "remove", path: "/blocks/b119/shots/b120" } as any,
      { op: "remove", path: "/blocks/b119/shots/b443" } as any,
      {
        op: "replace",
        path: "/blocks/b119/shots/b550/order",
        value: "a3",
      } as any,
    ]);
    const sql = capture.lastSqlFor("blocks");
    expect(sql).toBeDefined();
    // The bug signature: ensure SQL that reads from the original
    // column, e.g. `COALESCE(blocks #> ?::text[], '{}'::jsonb)`.
    // Post-fix the ensure for `{b119}` is skipped entirely because
    // the path exists in the pre-state snapshot and no ancestor
    // was removed in this batch.
    expect(sql).not.toMatch(/COALESCE\([^)]*blocks\s*#>/);
    // The `#-` removes for both shots must survive into the SQL.
    expect(sql).toContain("#-");
    const removeBindings = capture.lastBindingsFor("blocks") ?? [];
    expect(removeBindings).toContainEqual(["b119", "shots", "b120"]);
    expect(removeBindings).toContainEqual(["b119", "shots", "b443"]);
    // The `replace` for `b550/order` lands as a `jsonb_set_lax`.
    expect(sql).toMatch(/jsonb_set_lax\(/);
  });

  it("emits ensure when the path doesn't exist in the pre-batch snapshot", async () => {
    // Pre-state: blocks is empty. A deep replace forces every
    // intermediate to be ensured (none exist on the row). The
    // emits must use the segment-derived default ('{}' or '[]')
    // — pre-fix they used `COALESCE(column #> path, default)` and
    // post-fix they use the static default directly.
    const model = makeModel("p1", {});
    await adapter.patch(model, [
      {
        op: "replace",
        path: "/blocks/abc/portrait/url",
        value: "https://example.test/p.png",
      } as any,
    ]);
    const sql = capture.lastSqlFor("blocks");
    expect(sql).toBeDefined();
    expect(sql).toContain("'{}'::jsonb");
    // No `column #>` reads — every ensure uses the static default.
    expect(sql).not.toMatch(/COALESCE\([^)]*blocks\s*#>/);
  });

  it("re-emits ensure for a path whose ancestor was removed earlier in the batch", async () => {
    // Pre-state has /a/b/c. Op 1 removes /a/b. Op 2 adds /a/b/d.
    // The ensure for {a,b} must fire (it was removed) so the leaf
    // set has a parent to land on, but the ensure must use the
    // STATIC '{}'::jsonb default rather than reading from the
    // original column (which would resurrect the removed subtree).
    const model = makeModel("p1", { a: { b: { c: 1 } } });
    await adapter.patch(model, [
      { op: "remove", path: "/blocks/a/b" } as any,
      {
        op: "add",
        path: "/blocks/a/b/d",
        value: 2,
      } as any,
    ]);
    const sql = capture.lastSqlFor("blocks");
    expect(sql).toBeDefined();
    // Static default — no column-read for the resurrected path.
    expect(sql).not.toMatch(/COALESCE\([^)]*blocks\s*#>/);
    // The remove fires.
    expect(sql).toContain("#-");
  });

  it("evaluates a test against the locked database row, not the model snapshot", async () => {
    const model = makeModel();
    model.__data.title = "after";
    model.__serverSnapshot.title = "before";
    capture.setRow({
      id: "p1",
      title: "changed-concurrently",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      data: {},
    });

    await expect(
      adapter.patch(model, [
        { op: "test", path: "/title", value: "before" } as any,
        { op: "replace", path: "/title", value: "after" } as any,
      ]),
    ).rejects.toThrow("patch test failed at /title");

    expect(capture.updates).toHaveLength(0);
  });

  it("rejects copy and move before building SQL", async () => {
    const model = makeModel();
    await expect(
      adapter.patch(model, [
        { op: "copy", from: "/title", path: "/meta/leak" } as any,
      ]),
    ).rejects.toThrow('unsupported op "copy"');
    await expect(
      adapter.patch(model, [
        { op: "move", from: "/title", path: "/meta/leak" } as any,
      ]),
    ).rejects.toThrow('unsupported op "move"');
    expect(capture.updates).toHaveLength(0);
  });

  it("uses jsonb_insert for numeric array add so existing elements shift", async () => {
    const model = makeModel();
    model.__serverSnapshot.tags = ["a", "c"];
    await adapter.patch(model, [
      { op: "add", path: "/tags/1", value: "b" } as any,
    ]);

    const sql = capture.lastSqlFor("tags");
    expect(sql).toContain("jsonb_insert");
    expect(sql).not.toMatch(/jsonb_set_lax\([^]*\{1\}/);
    expect(capture.lastBindingsFor("tags")).toContainEqual(["1"]);
  });

  // ── Pure top-level ops (regression: no array vivification) ────────

  it("does not emit jsonb defaults for a top-level scalar replace", async () => {
    const model = makeModel();
    // Scalar column path — exercises the non-json branch, no
    // intermediate vivification.
    (ProjectModel.__schema as any).title = "string";
    try {
      await adapter.patch(model, [
        { op: "replace", path: "/title", value: "Hello" } as any,
      ]);
    } finally {
      delete (ProjectModel.__schema as any).title;
    }
    // Exactly one `raw()` call is expected: the stale-overflow scrub
    // that strips the freshly-patched key from the `data` jsonb blob
    // (`COALESCE(data, '{}'::jsonb) - ?::text[]`). This is the
    // counterpart to the `hydrate()` overflow filter — without it, a
    // patched column's stale snapshot in `data` could win on the next
    // read. Anything beyond this single raw() would indicate an
    // unwanted jsonb vivification side-effect on a scalar-only patch.
    expect(capture.raws.length).toBe(1);
    expect(capture.raws[0]!.sql).toContain("?::text[]");
    expect(capture.raws[0]!.bindings).toEqual(["data", ["title"]]);
  });

  it("binds camelCase identifiers and decoded JSON Pointer paths", async () => {
    const model = makeModel();
    model.__data.camelCase = {};
    model.__serverSnapshot.camelCase = {};

    await adapter.patch(model, [
      {
        op: "replace",
        path: '/camelCase/a,b/{brace}/quote"key/slash~1tilde~0',
        value: true,
      } as any,
    ]);

    const sql = capture.lastSqlFor("camelCase");
    const bindings = capture.lastBindingsFor("camelCase");
    expect(sql).toContain("COALESCE(??, '{}'::jsonb)");
    expect(bindings?.[0]).toBe("camelCase");
    expect(bindings).toContainEqual([
      "a,b",
      "{brace}",
      'quote"key',
      "slash/tilde~",
    ]);

    const knex = knexFactory({ client: "pg" });
    try {
      const compiled = knex.raw(sql!, bindings!).toSQL();
      expect(compiled.sql).toContain('COALESCE("camelCase"');
      expect(compiled.bindings).toContainEqual([
        "a,b",
        "{brace}",
        'quote"key',
        "slash/tilde~",
      ]);
    } finally {
      await knex.destroy();
    }
  });

  it("drops obsolete identifier bindings when replacing a JSON root", async () => {
    await adapter.patch(makeModel(), [
      {
        op: "replace",
        path: "/blocks",
        value: { next: true },
      } as any,
    ]);

    expect(capture.lastSqlFor("blocks")).toBe("?::jsonb");
    expect(capture.lastBindingsFor("blocks")).toEqual(['{"next":true}']);
  });
});
