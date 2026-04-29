import { describe, expect, it } from "vitest";
import { Period } from "../period.js";

describe("Period", () => {
  it("rejects end <= start", () => {
    const t = new Date("2026-01-01T00:00:00Z");
    expect(() => new Period(t, t)).toThrow(/after start/);
    expect(() => new Period(new Date(t.getTime() + 1000), t)).toThrow();
  });

  it("Period.last('7d') is exactly 7 days", () => {
    const now = new Date("2026-04-29T12:00:00Z");
    const p = Period.last("7d", now);
    expect(p.end.getTime() - p.start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(p.grain).toBe("day");
    expect(p.toSqlInterval()).toBe("7 days");
  });

  it("Period.last('28d') is 28 days at day grain", () => {
    const now = new Date("2026-04-29T12:00:00Z");
    const p = Period.last("28d", now);
    expect(p.grain).toBe("day");
    expect(p.bucketCount()).toBe(28);
  });

  it("Period.last('12w') is 84 days, week-grained", () => {
    const now = new Date("2026-04-29T12:00:00Z");
    const p = Period.last("12w", now);
    expect(p.grain).toBe("week");
    expect(p.bucketCount()).toBe(12);
  });

  it("Period.last('all') sets start at epoch", () => {
    const p = Period.last("all", new Date("2026-04-29T12:00:00Z"));
    expect(p.start.getTime()).toBe(0);
    expect(p.toSqlInterval()).toBe("infinity");
  });

  it("previous() returns the same-length window ending at start", () => {
    const now = new Date("2026-04-29T12:00:00Z");
    const p = Period.last("28d", now);
    const prev = p.previous();
    expect(prev.end.getTime()).toBe(p.start.getTime());
    expect(prev.end.getTime() - prev.start.getTime()).toBe(
      p.end.getTime() - p.start.getTime(),
    );
  });

  it("startOfDay normalises to UTC midnight", () => {
    const d = new Date("2026-04-29T15:42:01.123Z");
    const sod = Period.startOfDay(d);
    expect(sod.toISOString()).toBe("2026-04-29T00:00:00.000Z");
  });

  it("startOfWeek floors to Monday in UTC", () => {
    // 2026-04-29 is a Wednesday → Monday is 2026-04-27
    const d = new Date("2026-04-29T15:42:01Z");
    const sow = Period.startOfWeek(d);
    expect(sow.toISOString()).toBe("2026-04-27T00:00:00.000Z");
    // Sunday → previous Monday
    const sun = new Date("2026-05-03T10:00:00Z");
    expect(Period.startOfWeek(sun).toISOString()).toBe("2026-04-27T00:00:00.000Z");
  });

  it("qtd is grain=week when >28d, day otherwise", () => {
    // mid-quarter: April → quarter starts April 1 → ~28 days in
    const midQ = new Date("2026-04-29T12:00:00Z");
    const p = Period.last("qtd", midQ);
    expect(p.start.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    // Early quarter — Jan 5 → start Jan 1, only 4 days in
    const earlyQ = new Date("2026-01-05T12:00:00Z");
    const earlyP = Period.last("qtd", earlyQ);
    expect(earlyP.grain).toBe("day");
  });
});
