import { describe, expect, it } from "vitest";
import { diffCohorts, type DiffArgs } from "../state-change.js";

const baseArgs: Omit<DiffArgs, "priorCohorts" | "newCohorts"> = {
  org: "org_1",
  metricKey: "engagement.wau",
  sourceSnapshotId: "snap_new",
  previousSnapshotId: "snap_old",
  occurredAt: new Date("2026-04-30T00:00:00Z"),
};

describe("diffCohorts", () => {
  it("emits entered rows for first-run cohorts (no prior)", () => {
    const rows = diffCohorts({
      ...baseArgs,
      previousSnapshotId: null,
      priorCohorts: {},
      newCohorts: { active7d: ["pat_1", "pat_2"] },
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.transition).toBe("entered");
      expect(r.cohort).toBe("active7d");
      expect(r.previousSnapshotId).toBeNull();
      expect(r.sourceSnapshotId).toBe("snap_new");
    }
  });

  it("emits entered for new subjects, left for departed subjects", () => {
    const rows = diffCohorts({
      ...baseArgs,
      priorCohorts: { active7d: ["pat_1", "pat_2"] },
      newCohorts: { active7d: ["pat_2", "pat_3"] },
    });
    const entered = rows.filter((r) => r.transition === "entered");
    const left = rows.filter((r) => r.transition === "left");
    expect(entered.map((r) => r.subject)).toEqual(["pat_3"]);
    expect(left.map((r) => r.subject)).toEqual(["pat_1"]);
  });

  it("no-op when cohorts are unchanged", () => {
    const rows = diffCohorts({
      ...baseArgs,
      priorCohorts: { active7d: ["pat_1", "pat_2"] },
      newCohorts: { active7d: ["pat_2", "pat_1"] }, // same set, different order
    });
    expect(rows).toHaveLength(0);
  });

  it("handles cohorts that exist only in prior (everyone left)", () => {
    const rows = diffCohorts({
      ...baseArgs,
      priorCohorts: { needs_review: ["pat_1", "pat_2"] },
      newCohorts: {},
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.transition === "left")).toBe(true);
    expect(rows.every((r) => r.cohort === "needs_review")).toBe(true);
  });

  it("handles cohorts that exist only in new (everyone entered)", () => {
    const rows = diffCohorts({
      ...baseArgs,
      priorCohorts: {},
      newCohorts: { needs_review: ["pat_1"] },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.transition).toBe("entered");
  });

  it("emits per-cohort rows when one subject enters A and leaves B simultaneously", () => {
    const rows = diffCohorts({
      ...baseArgs,
      priorCohorts: { active7d: ["pat_1"] },
      newCohorts: { needs_review: ["pat_1"] },
    });
    expect(rows).toHaveLength(2);
    const left = rows.find((r) => r.cohort === "active7d");
    const entered = rows.find((r) => r.cohort === "needs_review");
    expect(left?.transition).toBe("left");
    expect(left?.subject).toBe("pat_1");
    expect(entered?.transition).toBe("entered");
    expect(entered?.subject).toBe("pat_1");
  });

  it("populates reasonCode/reason from cohortReasons on entered rows", () => {
    const rows = diffCohorts({
      ...baseArgs,
      priorCohorts: {},
      newCohorts: { needs_review: ["pat_1"] },
      cohortReasons: {
        needs_review: {
          pat_1: [
            { code: "biomarker_worsening", label: "HbA1c moved focus" },
          ],
        },
      },
    });
    expect(rows[0]?.reasonCode).toBe("biomarker_worsening");
    expect(rows[0]?.reason).toBe("HbA1c moved focus");
  });

  it("leaves reasonCode/reason null on left rows even when reasons map exists", () => {
    const rows = diffCohorts({
      ...baseArgs,
      priorCohorts: { needs_review: ["pat_1"] },
      newCohorts: { needs_review: [] },
      cohortReasons: {
        // The new map shouldn't apply to a "left" transition.
        needs_review: {
          pat_1: [{ code: "should_not_appear", label: "should not appear" }],
        },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.transition).toBe("left");
    expect(rows[0]?.reasonCode).toBeNull();
    expect(rows[0]?.reason).toBeNull();
  });

  it("uses only the first reason entry per subject (precedence applied upstream)", () => {
    const rows = diffCohorts({
      ...baseArgs,
      priorCohorts: {},
      newCohorts: { needs_review: ["pat_1"] },
      cohortReasons: {
        needs_review: {
          pat_1: [
            { code: "biomarker_worsening", label: "primary" },
            { code: "stalled_priority", label: "secondary" },
          ],
        },
      },
    });
    expect(rows[0]?.reasonCode).toBe("biomarker_worsening");
    expect(rows[0]?.reason).toBe("primary");
  });

  it("each emitted row gets a unique id", () => {
    const rows = diffCohorts({
      ...baseArgs,
      priorCohorts: {},
      newCohorts: { active7d: ["pat_1", "pat_2", "pat_3"] },
    });
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(rows.length);
  });
});
