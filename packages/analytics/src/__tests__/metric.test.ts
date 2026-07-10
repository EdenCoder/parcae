import { describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { Metric, runMetric, type MetricContext } from "../metric.js";
import { Period } from "../period.js";

class FixedMetric extends Metric {
  readonly key = "test.fixed";

  async compute() {
    return [{ value: 42 }];
  }
}

describe("snapshot persistence", () => {
  it("returns the retained row id after an upsert conflict", async () => {
    const retainedId = "existing-snapshot-id";
    const chain = {
      insert() { return this; },
      onConflict() { return this; },
      merge() { return this; },
      async returning() { return [{ id: retainedId, dimensions: {} }]; },
    };
    const db = (() => chain) as unknown as Knex;
    const now = new Date("2026-06-01T00:00:00Z");
    const context: MetricContext = {
      org: "org",
      period: Period.last("7d", now),
      db,
      now,
    };

    const [snapshot] = await runMetric(new FixedMetric(), context);

    expect(snapshot?.id).toBe(retainedId);
  });
});
