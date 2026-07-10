/**
 * End-to-end integration test for @parcae/analytics.
 *
 * Walks the full path:
 *   metric.event() registration → emit → analytics_event row →
 *   Metric.compute() → analytics_snapshot row →
 *   matview refresh → Contract read → freshness reflects computedAt →
 *   Detector → Composer (mocked) → Story persisted.
 *
 * Gated on `ANALYTICS_TEST_DB` env var. Skips with a descriptive
 * reason when not provided so unit-only `pnpm test` runs stay green
 * locally without postgres set up.
 */

import knexFactory, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  Contract,
  Detector,
  Metric,
  Period,
  StoryComposer,
  WauMetric,
  type CompletionFn,
  type ContractContext,
  type DetectorContext,
  type Finding,
  type MetricContext,
  type MetricSnapshot,
  type ProjectionContext,
  ANALYTICS_EVENT_TABLE,
  ANALYTICS_SNAPSHOT_TABLE,
  ANALYTICS_STATE_CHANGE_TABLE,
  STORY_TABLE,
  ensureAnalyticsTables,
  installAnalytics,
  defineMatview,
  ensureAllMatviews,
  refreshAll,
  clearMatviews,
  setEventEmitter,
  getEventEmitter,
  registerMetric,
  clearMetrics,
  registerDetector,
  clearDetectors,
  runMetric,
  ensureStoryTable,
  runProjection,
} from "../index.js";

const DB_URL = process.env.ANALYTICS_TEST_DB;
const skip = !DB_URL;
if (process.env.CI && skip) {
  throw new Error(
    "ANALYTICS_TEST_DB is required in CI for the analytics PostgreSQL integration test",
  );
}
const describeIfDb = skip ? describe.skip : describe;

let db: Knex;

beforeAll(async () => {
  if (skip) return;
  db = knexFactory({
    client: "pg",
    connection: DB_URL,
    pool: { min: 1, max: 4 },
  });
  // Best-effort cleanup of artifacts from prior runs.
  await db.raw(`DROP TABLE IF EXISTS ${STORY_TABLE} CASCADE`);
  await db.raw(`DROP TABLE IF EXISTS ${ANALYTICS_STATE_CHANGE_TABLE} CASCADE`);
  await db.raw(`DROP TABLE IF EXISTS ${ANALYTICS_SNAPSHOT_TABLE} CASCADE`);
  await db.raw(`DROP TABLE IF EXISTS ${ANALYTICS_EVENT_TABLE} CASCADE`);
  await db.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics_event_recent CASCADE`);

  await installAnalytics(db);
  await ensureStoryTable(db);
});

afterAll(async () => {
  if (skip) return;
  clearMetrics();
  clearDetectors();
  clearMatviews();
  setEventEmitter(null);
  await db.destroy();
});

describeIfDb("@parcae/analytics integration", () => {
  it("end-to-end: emit → snapshot → contract → projection", async () => {
    const org = "org_test_e2e";
    const now = new Date("2026-04-29T12:00:00Z");

    // Seed: emit some events directly via the installed emitter.
    const emitter = getEventEmitter();
    expect(emitter).not.toBeNull();
    if (!emitter) return;

    const subjects = ["p1", "p2", "p3", "p4"];
    for (const subject of subjects) {
      for (let day = 0; day < 7; day++) {
        await emitter.emit({
          org,
          subject,
          key: "activity.logged",
          occurredAt: new Date(now.getTime() - day * 24 * 60 * 60 * 1000),
          source: "mobile",
          dimensions: { activityType: "exercise", quality: "manual" },
        });
      }
    }

    const eventCount = await db(ANALYTICS_EVENT_TABLE)
      .where("org", org)
      .count<{ count: string }[]>("* as count")
      .first();
    expect(Number(eventCount?.count ?? 0)).toBe(28);

    // Run the WauMetric — should see all 4 patients as active in the last 7 days.
    registerMetric(new WauMetric());
    const period = Period.last("7d", now);

    const ctx: MetricContext = { org, period, db, now };
    const persisted = await runMetric(new WauMetric(), ctx);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.value).toBe(4);
    expect(
      ((persisted[0]?.metadata as { cohorts?: { active7d?: string[] } })
        ?.cohorts?.active7d ?? []).sort(),
    ).toEqual(subjects.sort());

    // Snapshot row written
    const snapshot = await db(ANALYTICS_SNAPSHOT_TABLE)
      .where({ org, metricKey: "engagement.wau" })
      .first();
    expect(snapshot).toBeDefined();
    expect(Number(snapshot.value)).toBe(4);

    // Contract: simple inline subclass that reads the snapshot.
    interface DashPayload {
      wau: number | null;
    }
    class DashContract extends Contract<DashPayload> {
      readonly path = "/v1/test-dashboard";
      readonly metrics = ["engagement.wau"];
      async data(c: ContractContext): Promise<DashPayload> {
        const row = await c.db(ANALYTICS_SNAPSHOT_TABLE)
          .where({ org: c.org, metricKey: "engagement.wau" })
          .orderBy("periodStart", "desc")
          .first();
        return { wau: row ? Number(row.value) : null };
      }
    }

    const dash = new DashContract();
    const dashCtx: ContractContext = {
      org,
      period,
      db,
      now,
      req: { query: {}, params: {} },
    };
    const data = await dash.data(dashCtx);
    expect(data.wau).toBe(4);

    const fresh = await (
      dash as DashContract & { freshness: (c: ContractContext) => Promise<unknown> }
    ).freshness(dashCtx);
    expect((fresh as { asOf: Date | null }).asOf).toBeInstanceOf(Date);

    // Matview: define a trivial recent-activity view and refresh.
    defineMatview({
      name: "analytics_event_recent",
      sql: `SELECT org, subject, COUNT(*)::int AS n
              FROM ${ANALYTICS_EVENT_TABLE}
             WHERE "occurredAt" >= now() - interval '7 days'
             GROUP BY org, subject`,
      uniqueColumns: ["org", "subject"],
    });
    await ensureAllMatviews(db);
    const refreshOutcomes = await refreshAll(db);
    expect(refreshOutcomes.every((o) => o.ok)).toBe(true);

    // Projection: a fake detector that fires once, a mock composer.
    class FakeDetector extends Detector {
      readonly key = "fake";
      async detect(_ctx: DetectorContext): Promise<Finding[]> {
        return [
          {
            key: "fake.cohort_alive",
            severity: "info",
            data: { active7d: 4 },
            subjects,
            narrativeSeed: "All four welcomed patients logged this week",
            relatedMetrics: ["engagement.wau"],
          },
        ];
      }
    }
    registerDetector(new FakeDetector());

    const complete: CompletionFn = async () => ({
      json: {
        title: "All four logged this week",
        body: "4 of 4 welcomed patients logged at least once.",
        quotedValues: [4],
        metricRefs: ["engagement.wau"],
      },
    });

    const projection: ProjectionContext = {
      org,
      locale: "en",
      period,
      db,
      now,
      composer: new StoryComposer({ complete }),
      maxStories: 6,
    };
    const stories = await runProjection(projection);
    expect(stories).toHaveLength(1);
    expect(stories[0]?.title).toBe("All four logged this week");
    expect(stories[0]?.subjects).toEqual(subjects);

    // Reruns replace cleanly — same (org, locale, periodEnd) → no drift.
    const rerun = await runProjection(projection);
    expect(rerun).toHaveLength(1);
    const totalRows = await db(STORY_TABLE)
      .where({ org, periodEnd: period.end })
      .count<{ count: string }[]>("* as count")
      .first();
    expect(Number(totalRows?.count ?? 0)).toBe(1);
  });

  it("Metric snapshot upsert is idempotent for same period", async () => {
    const org = "org_test_upsert";
    const now = new Date("2026-04-29T12:00:00Z");
    const period = Period.last("7d", now);

    class FixedMetric extends Metric {
      readonly key = "test.fixed";
      readonly grain = "week" as const;
      private value: number;
      constructor(value: number) {
        super();
        this.value = value;
      }
      async compute(_: MetricContext): Promise<MetricSnapshot[]> {
        return [{ value: this.value, metadata: { run: this.value } }];
      }
    }

    const [first] = await runMetric(new FixedMetric(11), { org, period, db, now });
    const [second] = await runMetric(new FixedMetric(22), { org, period, db, now });

    expect(second?.id).toBe(first?.id);

    const rows = await db(ANALYTICS_SNAPSHOT_TABLE)
      .where({ org, metricKey: "test.fixed" });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.value)).toBe(22);
    const meta =
      typeof rows[0]?.metadata === "string"
        ? JSON.parse(rows[0].metadata)
        : rows[0]?.metadata;
    expect(meta).toEqual({ run: 22 });
  });

  it("rejects existing tables whose conflict targets are not unique", async () => {
    await db.raw("DROP INDEX analytics_snapshot_unique_idx");
    try {
      await expect(ensureAnalyticsTables(db)).rejects.toThrow(
        "analytics_snapshot lacks a valid unique index or constraint",
      );
    } finally {
      await db.raw(
        `CREATE UNIQUE INDEX analytics_snapshot_unique_idx
           ON ${ANALYTICS_SNAPSHOT_TABLE}
           (org, "metricKey", grain, "periodStart", dimensions)`,
      );
    }

    await db.raw("DROP INDEX analytics_state_change_idempotent_idx");
    try {
      await expect(ensureAnalyticsTables(db)).rejects.toThrow(
        "analytics_state_change lacks a valid unique index or constraint",
      );
    } finally {
      await db.raw(
        `CREATE UNIQUE INDEX analytics_state_change_idempotent_idx
           ON ${ANALYTICS_STATE_CHANGE_TABLE}
           (org, subject, cohort, "sourceSnapshotId", transition)`,
      );
    }
  });
});
