import { describe, expect, it } from "vitest";
import type { Knex } from "knex";
import {
  canonicalDimensions,
  ensureAnalyticsTables,
} from "../schema.js";
import { ensureStoryTable } from "../story.js";

describe("canonicalDimensions", () => {
  it("sorts top-level keys", () => {
    expect(canonicalDimensions({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("sorts nested keys recursively", () => {
    expect(
      canonicalDimensions({ b: { y: 2, x: 1 }, a: ["k", "j"] }),
    ).toBe('{"a":["k","j"],"b":{"x":1,"y":2}}');
  });

  it("handles empty objects", () => {
    expect(canonicalDimensions({})).toBe("{}");
  });

  it("preserves array order (semantic, not sorted)", () => {
    expect(canonicalDimensions({ tiers: ["thriving", "steady", "slipping"] }))
      .toBe('{"tiers":["thriving","steady","slipping"]}');
  });
});

describe("analytics DDL upgrades", () => {
  it("adds owned columns and indexes to existing tables", async () => {
    const ddl = createDdlDatabase();

    await ensureAnalyticsTables(ddl.db);
    await ensureStoryTable(ddl.db);

    expect(ddl.columns.get("analytics_event")).toEqual(expect.arrayContaining([
      "source",
      "dimensions",
      "createdAt",
    ]));
    expect(ddl.columns.get("analytics_snapshot")).toEqual(expect.arrayContaining([
      "metadata",
      "metricVersion",
      "computedAt",
    ]));
    expect(ddl.columns.get("analytics_state_change")).toEqual(expect.arrayContaining([
      "reasonCode",
      "reason",
      "createdAt",
    ]));
    expect(ddl.columns.get("analytics_story")).toEqual(expect.arrayContaining([
      "locale",
      "sourceFindingKeys",
      "createdAt",
    ]));
    expect(ddl.sql.join("\n")).not.toContain("analytics_snapshot_unique_idx");
    expect(ddl.sql.join("\n")).not.toContain("analytics_state_change_idempotent_idx");
    expect(ddl.sql.join("\n")).toContain("analytics_story_org_locale_period_idx");
    expect(ddl.catalogChecks).toEqual([
      "analytics_snapshot",
      "analytics_state_change",
    ]);
  });

  it("fails instead of adding duplicate empty identity keys", async () => {
    const ddl = createDdlDatabase();
    ddl.existing.get("analytics_event")?.delete("id");

    await expect(ensureAnalyticsTables(ddl.db)).rejects.toThrow(
      "analytics_event is missing structural columns: id",
    );

    expect([...ddl.columns.values()].flat()).not.toContain("id");
  });

  it("fails when an existing snapshot table lacks its conflict target", async () => {
    const ddl = createDdlDatabase();
    ddl.uniqueIndexes.set("analytics_snapshot", []);

    await expect(ensureAnalyticsTables(ddl.db)).rejects.toThrow(
      "analytics_snapshot lacks a valid unique index or constraint for conflict target (org, metricKey, grain, periodStart, dimensions). ON CONFLICT writes are unsafe; resolve duplicate rows, then add the target in an explicit versioned migration.",
    );

    expect(ddl.sql.join("\n")).not.toContain("CREATE UNIQUE INDEX");
  });

  it("fails when an existing state-change table lacks its conflict target", async () => {
    const ddl = createDdlDatabase();
    ddl.uniqueIndexes.set("analytics_state_change", []);

    await expect(ensureAnalyticsTables(ddl.db)).rejects.toThrow(
      "analytics_state_change lacks a valid unique index or constraint for conflict target (org, subject, cohort, sourceSnapshotId, transition)",
    );

    expect(ddl.sql.join("\n")).not.toContain("CREATE UNIQUE INDEX");
  });
});

function createDdlDatabase() {
  const existing = new Map<string, Set<string>>([
    ["analytics_event", new Set([
      "id", "org", "subject", "key", "occurredAt",
    ])],
    ["analytics_snapshot", new Set([
      "id", "org", "metricKey", "grain", "periodStart", "periodEnd",
      "value", "dimensions",
    ])],
    ["analytics_state_change", new Set([
      "id", "org", "subject", "cohort", "transition", "occurredAt",
      "metricKey", "sourceSnapshotId",
    ])],
    ["analytics_story", new Set([
      "id", "org", "key", "status", "severity", "title", "body", "rank",
      "subjects", "data", "metricRefs", "quotedValues", "modelName",
      "periodEnd",
    ])],
  ]);
  const columns = new Map<string, string[]>();
  const uniqueIndexes = new Map<string, string[][]>([
    ["analytics_snapshot", [[
      "org", "metricKey", "grain", "periodStart", "dimensions",
    ]]],
    ["analytics_state_change", [[
      "org", "subject", "cohort", "sourceSnapshotId", "transition",
    ]]],
  ]);
  const catalogChecks: string[] = [];
  const sql: string[] = [];
  const columnChain = new Proxy({}, {
    get: () => () => columnChain,
  });
  const tableBuilder = new Proxy({}, {
    get: (_target, _property) => (name: string) => {
      const table = currentTable!;
      const names = columns.get(table) ?? [];
      names.push(name);
      columns.set(table, names);
      existing.get(table)?.add(name);
      return columnChain;
    },
  });
  let currentTable: string | null = null;
  const schema = {
    hasTable: async () => true,
    hasColumn: async (table: string, column: string) =>
      existing.get(table)?.has(column) ?? false,
    alterTable: async (table: string, add: (builder: unknown) => void) => {
      currentTable = table;
      add(tableBuilder);
      currentTable = null;
    },
  };
  const db = {
    schema,
    fn: { now: () => "now" },
    raw: async (statement: string, bindings?: unknown[]) => {
      sql.push(statement);
      if (statement.includes("pg_catalog.pg_index")) {
        const table = String(bindings?.[0]);
        catalogChecks.push(table);
        return {
          rows: (uniqueIndexes.get(table) ?? []).map((indexColumns, position) => ({
            indexName: `${table}_${position}`,
            columns: indexColumns,
          })),
        };
      }
    },
  } as unknown as Knex;
  return { db, columns, existing, uniqueIndexes, catalogChecks, sql };
}
