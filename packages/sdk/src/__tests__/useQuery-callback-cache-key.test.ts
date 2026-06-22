import { describe, expect, it } from "vitest";

import { __test as useQueryTest } from "../react/useQuery";

// A `.where(callback)` step records the callback FUNCTION in its args
// (see `lazyQuery` in @parcae/model). The cache key must reflect the
// values the callback closes over, otherwise two different searches
// (`name ilike %Jane%` vs `%Jill%`) collide on one cache entry and the
// second search never refetches — it just re-reads the first search's
// rows. These steps mirror the patients-grid name-or-email search.
function searchSteps(term: string): unknown[] {
  return [
    { method: "where", args: [{}] },
    {
      method: "where",
      args: [
        (b: any) =>
          b
            .where("name", "ilike", `%${term}%`)
            .orWhere("email", "ilike", `%${term}%`),
      ],
    },
    { method: "limit", args: [25] },
  ];
}

describe("useQuery cache key — where(callback) serialization", () => {
  it("gives different keys to callbacks that close over different terms", () => {
    const jane = useQueryTest.buildKey("patient", "u1", searchSteps("Jane"));
    const jill = useQueryTest.buildKey("patient", "u1", searchSteps("Jill"));

    expect(jane).not.toEqual(jill);
    expect(jane).toContain("Jane");
    expect(jill).toContain("Jill");
  });

  it("gives a stable key for the same term across rebuilds", () => {
    expect(useQueryTest.buildKey("patient", "u1", searchSteps("Jane"))).toEqual(
      useQueryTest.buildKey("patient", "u1", searchSteps("Jane")),
    );
  });

  it("captures nested orWhere predicates, not just the first call", () => {
    const onlyName: unknown[] = [
      {
        method: "where",
        args: [(b: any) => b.where("name", "ilike", "%Jane%")],
      },
    ];
    const nameOrEmail: unknown[] = [
      {
        method: "where",
        args: [
          (b: any) =>
            b
              .where("name", "ilike", "%Jane%")
              .orWhere("email", "ilike", "%Jane%"),
        ],
      },
    ];
    expect(useQueryTest.buildKey("patient", "u1", onlyName)).not.toEqual(
      useQueryTest.buildKey("patient", "u1", nameOrEmail),
    );
  });

  it("keeps the user id and :nosub suffix intact alongside a callback step", () => {
    const dyn = useQueryTest.buildKey("patient", "u1", searchSteps("Jane"));
    const stat = useQueryTest.buildKey(
      "patient",
      "u1",
      searchSteps("Jane"),
      false,
    );
    expect(dyn).toContain(":u1:");
    expect(stat.endsWith(":nosub")).toBe(true);
    expect(dyn).not.toEqual(stat);
  });
});
