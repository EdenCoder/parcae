import { afterEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import {
  Detector,
  clearDetectors,
  registerDetector,
  type DetectorContext,
  type Finding,
} from "../finding.js";
import { Period } from "../period.js";
import { runProjection } from "../story.js";

class FindingDetector extends Detector {
  readonly key = "test.finding";

  async detect(_ctx: DetectorContext): Promise<Finding[]> {
    return [{
      key: "test.finding",
      severity: "info",
      data: {},
      subjects: [],
      narrativeSeed: "A valid story",
      relatedMetrics: [],
    }];
  }
}

afterEach(() => {
  clearDetectors();
});

describe("story replacement", () => {
  it("rolls the delete back when replacement insertion fails", async () => {
    const database = createStoryDatabase([{ id: "retained", locale: "en" }]);
    registerDetector(new FindingDetector());

    await expect(runProjection({
      org: "org",
      locale: "en",
      period: Period.last("7d", new Date("2026-06-01T00:00:00Z")),
      now: new Date("2026-06-01T00:00:00Z"),
      db: database.db,
    })).rejects.toThrow("insert failed");

    expect(database.rows()).toEqual([{ id: "retained", locale: "en" }]);
  });

  it("purges legacy und rows when writing a real locale", async () => {
    const period = Period.last("7d", new Date("2026-06-01T00:00:00Z"));
    const otherPeriod = Period.last("7d", new Date("2026-05-01T00:00:00Z"));
    const database = createPersistingStoryDatabase([
      { id: "legacy", org: "org", locale: "und", periodEnd: period.end },
      { id: "other-org", org: "other", locale: "und", periodEnd: period.end },
      { id: "other-period", org: "org", locale: "und", periodEnd: otherPeriod.end },
      { id: "fr", org: "org", locale: "fr", periodEnd: period.end },
    ]);
    registerDetector(new FindingDetector());

    await runProjection({
      org: "org",
      locale: "en",
      period,
      now: new Date("2026-06-01T00:00:00Z"),
      db: database.db,
    });

    expect(database.rows().some((row) => row.id === "legacy")).toBe(false);
    expect(database.rows().some((row) => row.id === "other-org")).toBe(true);
    expect(database.rows().some((row) => row.id === "other-period")).toBe(true);
    expect(database.rows().some((row) => row.id === "fr")).toBe(true);
    expect(database.rows().some((row) => row.locale === "en")).toBe(true);
  });

  it("encodes the advisory lock identity without NUL bytes", async () => {
    const period = Period.last("7d", new Date("2026-06-01T00:00:00Z"));
    const database = createPersistingStoryDatabase([], "pg");
    registerDetector(new FindingDetector());

    await runProjection({
      org: "org\u0000one",
      locale: "en",
      period,
      now: new Date("2026-06-01T00:00:00Z"),
      db: database.db,
    });

    const lock = database.rawCalls().find((call) =>
      call.statement.includes("pg_advisory_xact_lock"),
    );
    const identity = lock?.bindings?.[0];
    expect(typeof identity).toBe("string");
    expect(identity).not.toContain("\u0000");
    expect(JSON.parse(String(identity))).toEqual([
      "org\u0000one",
      "en",
      period.end.toISOString(),
    ]);
  });
});

function createStoryDatabase(initialRows: Array<Record<string, unknown>>) {
  let rows = [...initialRows];
  const query = () => {
    const chain = {
      where() { return this; },
      async delete() {
        rows = [];
      },
      async insert() {
        throw new Error("insert failed");
      },
    };
    return chain;
  };
  const db = Object.assign(query, {
    schema: {
      hasTable: async () => true,
      hasColumn: async () => true,
    },
    fn: { now: () => "now" },
    raw: async () => undefined,
    client: { config: { client: "sqlite" } },
    transaction: async (run: (trx: unknown) => Promise<void>) => {
      const before = [...rows];
      const trx = Object.assign(query, {
        client: { config: { client: "sqlite" } },
        raw: async () => undefined,
      });
      try {
        await run(trx);
      } catch (error) {
        rows = before;
        throw error;
      }
    },
  }) as unknown as Knex;
  return { db, rows: () => rows };
}

function createPersistingStoryDatabase(
  initialRows: Array<Record<string, unknown>>,
  client = "sqlite",
) {
  let rows = [...initialRows];
  const rawCalls: Array<{ statement: string; bindings?: unknown[] }> = [];
  const raw = async (statement: string, bindings?: unknown[]) => {
    rawCalls.push({ statement, bindings });
  };
  const query = () => {
    const filters: Array<[string, unknown]> = [];
    return {
      where(field: string, value: unknown) {
        filters.push([field, value]);
        return this;
      },
      async delete() {
        rows = rows.filter((row) =>
          !filters.every(([field, value]) => row[field] === value),
        );
      },
      async insert(nextRows: Array<Record<string, unknown>>) {
        rows.push(...nextRows);
      },
    };
  };
  const trx = Object.assign(query, {
    client: { config: { client } },
    raw,
  });
  const db = Object.assign(query, {
    schema: {
      hasTable: async () => true,
      hasColumn: async () => true,
    },
    fn: { now: () => "now" },
    raw,
    client: { config: { client } },
    transaction: async (run: (transaction: typeof trx) => Promise<void>) =>
      run(trx),
  }) as unknown as Knex;
  return { db, rows: () => rows, rawCalls: () => rawCalls };
}
