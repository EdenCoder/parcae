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
import { BackendAdapter } from "../adapters/model";
import { clearHooks } from "../routing/hook";

// ─── Recording knex stub ────────────────────────────────────────────────────

interface RawCall {
  sql: string;
  bindings: unknown[];
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
  lastBindingsFor: (column: string) => unknown[] | undefined;
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

  // Tag returned from raw() so update() can recognise its own raws
  // and (for the test) extract the sql + bindings.
  type Raw = { __raw: true; sql: string; bindings: unknown[] };

  const knex: any = (table: string) => {
    let whereCol = "";
    let whereVal: unknown = undefined;
    return {
      where(col: string, val: unknown) {
        whereCol = col;
        whereVal = val;
        return this;
      },
      async update(fields: Record<string, unknown>) {
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
      },
    };
  };

  knex.raw = (sql: string, bindings: unknown[] = []) => {
    raws.push({ sql, bindings });
    return { __raw: true, sql, bindings } as Raw;
  };

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
          return (v as any).bindings as unknown[];
        }
        return undefined;
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
  },
};

function makeModel(id = "p1"): any {
  return {
    constructor: ProjectModel,
    id,
    __data: { id, blocks: {}, tags: [], meta: {} },
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
    expect(capture.raws.length).toBe(0);
  });
});
