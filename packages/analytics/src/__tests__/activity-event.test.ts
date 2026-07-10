import { describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { ActivityEvent } from "../activity-event.js";

class AcceptedEvent extends ActivityEvent {
  static readonly keys = ["accepted.one", "accepted.two"];
}

describe("ActivityEvent.query", () => {
  it("filters the declarative key vocabulary in SQL before limit", async () => {
    const operations: string[] = [];
    const chain = {
      select() { return this; },
      where() { return this; },
      whereIn(column: string, values: readonly string[]) {
        operations.push(`whereIn:${column}:${values.join(",")}`);
        return this;
      },
      orderBy() {
        operations.push("orderBy");
        return this;
      },
      limit() {
        operations.push("limit");
        return this;
      },
      then(resolve: (rows: unknown[]) => void) {
        resolve([]);
      },
    };
    const db = (() => chain) as unknown as Knex;

    await AcceptedEvent.query(db, { limit: 1 });

    expect(operations).toEqual([
      "whereIn:key:accepted.one,accepted.two",
      "orderBy",
      "limit",
    ]);
  });
});
