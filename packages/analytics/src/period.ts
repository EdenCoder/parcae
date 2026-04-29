/**
 * @parcae/analytics — Period
 *
 * Windowing math. A `Period` is a half-open interval `[start, end)` plus a
 * grain (`day` | `week` | `month`). Used everywhere snapshots are filled,
 * detectors compare windows, and contracts ask for a range.
 *
 * Why a class and not bare Date pairs: `.previous()` and `.toSqlInterval()`
 * are operations the call sites actually want. Inlining
 * `now - 28 days` everywhere is how the old metric runners ended up with
 * subtle off-by-day errors at DST transitions.
 */
export type Grain = "day" | "week" | "month";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export class Period {
  readonly start: Date;
  readonly end: Date;
  readonly grain: Grain;

  constructor(start: Date, end: Date, grain: Grain = "day") {
    if (end <= start) {
      throw new RangeError(
        `Period end (${end.toISOString()}) must be after start (${start.toISOString()})`,
      );
    }
    this.start = new Date(start);
    this.end = new Date(end);
    this.grain = grain;
  }

  /**
   * Build a period covering the trailing `spec` ending at `now`. `spec`
   * is one of `'7d'`, `'28d'`, `'12w'`, `'qtd'`, `'all'`, or a `{ days |
   * weeks | months }` object. `'all'` returns a half-open interval from
   * the unix epoch to `now` — callers using `.toSqlInterval()` should
   * branch on it.
   */
  static last(
    spec: "7d" | "28d" | "12w" | "qtd" | "all" | { days?: number; weeks?: number; months?: number },
    now: Date = new Date(),
  ): Period {
    const end = new Date(now);
    if (spec === "7d") return new Period(addDays(end, -7), end, "day");
    if (spec === "28d") return new Period(addDays(end, -28), end, "day");
    if (spec === "12w") return new Period(addDays(end, -84), end, "week");
    if (spec === "qtd") {
      const start = quarterStart(end);
      const grain: Grain = end.getTime() - start.getTime() > 28 * DAY_MS ? "week" : "day";
      return new Period(start, end, grain);
    }
    if (spec === "all") return new Period(new Date(0), end, "week");

    const days = (spec.days ?? 0) + (spec.weeks ?? 0) * 7;
    const start = days ? addDays(end, -days) : addMonths(end, -(spec.months ?? 1));
    const grain: Grain =
      days >= 84 || (spec.months ?? 0) >= 3
        ? "week"
        : days >= 28
          ? "week"
          : "day";
    return new Period(start, end, grain);
  }

  /**
   * The same-length window that ends where this one starts. Used for
   * delta calculations.
   */
  previous(): Period {
    const len = this.end.getTime() - this.start.getTime();
    return new Period(new Date(this.start.getTime() - len), this.start, this.grain);
  }

  /**
   * Postgres interval literal for the period's length. Returns
   * `"infinity"` for `start === epoch` so the call site can branch.
   */
  toSqlInterval(): string {
    if (this.start.getTime() === 0) return "infinity";
    const ms = this.end.getTime() - this.start.getTime();
    const days = Math.round(ms / DAY_MS);
    return `${days} days`;
  }

  /** Number of grain buckets in the period. */
  bucketCount(): number {
    const ms = this.end.getTime() - this.start.getTime();
    if (this.grain === "day") return Math.round(ms / DAY_MS);
    if (this.grain === "week") return Math.round(ms / WEEK_MS);
    return monthsBetween(this.start, this.end);
  }

  /** ISO start-of-day in UTC. The canonical normalisation for snapshot keys. */
  static startOfDay(d: Date): Date {
    const out = new Date(d);
    out.setUTCHours(0, 0, 0, 0);
    return out;
  }

  /** ISO start-of-week (Monday) in UTC. */
  static startOfWeek(d: Date): Date {
    const out = Period.startOfDay(d);
    const day = out.getUTCDay();
    const offset = (day + 6) % 7;
    return addDays(out, -offset);
  }
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

function addMonths(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + n);
  return out;
}

function quarterStart(d: Date): Date {
  const month = d.getUTCMonth();
  const qStartMonth = month - (month % 3);
  return new Date(Date.UTC(d.getUTCFullYear(), qStartMonth, 1));
}

function monthsBetween(start: Date, end: Date): number {
  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth())
  );
}
