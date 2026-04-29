import { afterEach, describe, expect, it } from "vitest";
import {
  Detector,
  type DetectorContext,
  type Finding,
  clearDetectors,
  registerDetector,
  runDetectors,
} from "../finding.js";

class FakeAtomic extends Detector {
  readonly key = "fake.atomic";
  constructor(private readonly findings: Finding[]) {
    super();
  }
  async detect(): Promise<Finding[]> {
    return this.findings;
  }
}

class FakeMeta extends Detector {
  readonly key = "fake.meta";
  readonly input = "findings" as const;
  constructor(
    private readonly fn: (findings: Finding[]) => Finding[] = (f) => [
      {
        key: "fake.meta.cluster",
        severity: "watch",
        data: { sources: f.length },
        subjects: f.flatMap((x) => x.subjects),
        narrativeSeed: `${f.length} signals agree`,
        relatedMetrics: f.flatMap((x) => x.relatedMetrics),
        sourceFindings: f,
      },
    ],
  ) {
    super();
  }
  async detect(_ctx: DetectorContext, atomic: Finding[] = []): Promise<Finding[]> {
    return this.fn(atomic);
  }
}

class ThrowingDetector extends Detector {
  readonly key = "fake.throw";
  async detect(): Promise<Finding[]> {
    throw new Error("boom");
  }
}

afterEach(() => {
  clearDetectors();
});

describe("runDetectors", () => {
  const ctx: DetectorContext = {
    org: "org_1",
    period: {
      start: new Date(0),
      end: new Date(),
      grain: "week",
    } as DetectorContext["period"],
    db: {} as DetectorContext["db"],
    now: new Date(),
  };

  it("returns atomic + meta findings", async () => {
    registerDetector(
      new FakeAtomic([
        {
          key: "atomic.a",
          severity: "info",
          data: {},
          subjects: ["p1"],
          narrativeSeed: "a",
          relatedMetrics: [],
        },
      ]),
    );
    registerDetector(new FakeMeta());
    const out = await runDetectors(ctx);
    expect(out.map((f) => f.key)).toEqual(["atomic.a", "fake.meta.cluster"]);
    const meta = out.find((f) => f.key === "fake.meta.cluster");
    expect(meta?.sourceFindings).toHaveLength(1);
  });

  it("isolates a throwing detector — others still emit", async () => {
    registerDetector(new ThrowingDetector());
    registerDetector(
      new FakeAtomic([
        {
          key: "atomic.ok",
          severity: "info",
          data: {},
          subjects: [],
          narrativeSeed: "ok",
          relatedMetrics: [],
        },
      ]),
    );
    const out = await runDetectors(ctx);
    expect(out.map((f) => f.key)).toEqual(["atomic.ok"]);
  });
});
