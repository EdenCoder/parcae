/**
 * @parcae/analytics — Story persistence + projection runner
 *
 * The projection runner is the third stage of the insights pipeline:
 * detectors produce findings, composer turns each finding into prose,
 * the projection ranks / merges / persists `Story` rows.
 *
 * Stories are scoped per `(org, locale, periodEnd)`. Same-period reruns
 * replace stories cleanly — no drift between a fresh run and stale rows.
 */

import type { Knex } from "knex";
import { log } from "@parcae/backend";
import type { ComposedStory } from "./composer.js";
import { StoryComposer, validateAgainstFinding } from "./composer.js";
import type { Finding, Severity } from "./finding.js";
import { runDetectors, type DetectorContext } from "./finding.js";
import { generateId } from "./id.js";
import {
  assertStructuralColumns,
  ensureAdditiveColumn,
} from "./schema-upgrade.js";

export const STORY_TABLE = "analytics_story";

export type StoryStatus =
  | "priority"
  | "working"
  | "slipping"
  | "watching"
  | "ready_to_ship";

export interface StoryRow {
  id: string;
  org: string;
  locale: string;
  key: string;
  status: StoryStatus;
  severity: Severity;
  title: string;
  body: string;
  rank: number;
  /** Patient ids the clinician can drill down to. */
  subjects: string[];
  /** Echo of the finding's `data` for the modal expander. */
  data: Record<string, unknown>;
  /** Metric keys the body claims to be quoting. */
  metricRefs: string[];
  /** Numbers the body cited. */
  quotedValues: number[];
  /** Source attribution: `"<llm-model>"` or `"detector:<key>"`. */
  modelName: string;
  /** Source findings for meta-stories. Empty for atomic stories. */
  sourceFindingKeys: string[];
  periodEnd: Date;
  createdAt: Date;
}

export async function ensureStoryTable(db: Knex): Promise<void> {
  const exists = await db.schema.hasTable(STORY_TABLE);
  if (!exists) {
    await db.schema.createTable(STORY_TABLE, (t) => {
      t.string("id", 32).primary();
      t.string("org", 64).notNullable();
      t.string("locale", 32).notNullable();
      t.string("key", 128).notNullable();
      t.string("status", 16).notNullable();
      t.string("severity", 8).notNullable();
      t.string("title", 256).notNullable();
      t.text("body").notNullable();
      t.integer("rank").notNullable().defaultTo(0);
      t.jsonb("subjects").notNullable().defaultTo("[]");
      t.jsonb("data").notNullable().defaultTo("{}");
      t.jsonb("metricRefs").notNullable().defaultTo("[]");
      t.jsonb("quotedValues").notNullable().defaultTo("[]");
      t.string("modelName", 128).notNullable().defaultTo("");
      t.jsonb("sourceFindingKeys").notNullable().defaultTo("[]");
      t.timestamp("periodEnd", { useTz: true }).notNullable();
      t.timestamp("createdAt", { useTz: true }).notNullable().defaultTo(db.fn.now());
    });
  } else {
    await assertStructuralColumns(db, STORY_TABLE, [
      "id",
      "org",
      "key",
      "status",
      "severity",
      "title",
      "body",
      "rank",
      "subjects",
      "data",
      "metricRefs",
      "quotedValues",
      "modelName",
      "periodEnd",
    ]);
    await ensureAdditiveColumn(db, STORY_TABLE, "locale", (t) =>
      t.string("locale", 32).notNullable().defaultTo("und"),
    );
    await ensureAdditiveColumn(db, STORY_TABLE, "sourceFindingKeys", (t) =>
      t.jsonb("sourceFindingKeys").notNullable().defaultTo("[]"),
    );
    await ensureAdditiveColumn(db, STORY_TABLE, "createdAt", (t) =>
      t.timestamp("createdAt", { useTz: true }).notNullable().defaultTo(db.fn.now()),
    );
  }
  await db.raw(
    `CREATE INDEX IF NOT EXISTS analytics_story_org_locale_period_idx
       ON ${STORY_TABLE} (org, locale, "periodEnd" DESC)`,
  );
}

export interface ProjectionContext extends DetectorContext {
  /** BCP 47 locale of generated title/body prose. */
  locale: string;
  composer?: StoryComposer;
  /** Hard ceiling on stories per run. Default 6. */
  maxStories?: number;
}

const DEFAULT_MAX_STORIES = 6;

const SEVERITY_RANK: Record<Severity, number> = {
  action: 3,
  watch: 2,
  info: 1,
};

export async function runProjection(
  ctx: ProjectionContext,
): Promise<StoryRow[]> {
  const findings = await runDetectors(ctx);
  if (findings.length === 0) return persistStories(ctx, []);

  const composed = ctx.composer
    ? await composeAll(ctx.composer, findings)
    : findings.map((f) => fallbackStory(f));

  const ranked = rankAndDedupe(composed, ctx.maxStories ?? DEFAULT_MAX_STORIES);
  const single = enforceSinglePriority(ranked);
  return persistStories(ctx, single);
}

interface RankedStory {
  finding: Finding;
  composed: ComposedStory;
  rank: number;
  status: StoryStatus;
}

async function composeAll(
  composer: StoryComposer,
  findings: Finding[],
): Promise<RankedStory[]> {
  const out: RankedStory[] = [];
  const settled = await Promise.allSettled(
    findings.map(async (f) => {
      const story = await composer.compose({ finding: f });
      validateAgainstFinding(story, f);
      return { finding: f, composed: story };
    }),
  );
  for (const s of settled) {
    if (s.status !== "fulfilled") {
      log.warn(`[projection] composer rejected: ${s.reason}`);
      continue;
    }
    const { finding, composed } = s.value;
    out.push({
      finding,
      composed,
      rank: rankOf(finding, composed),
      status: deriveStatus(finding),
    });
  }
  return out;
}

function fallbackStory(finding: Finding): RankedStory {
  const composed: ComposedStory = {
    key: finding.key,
    severity: finding.severity,
    title: finding.narrativeSeed.slice(0, 72),
    body: finding.narrativeSeed,
    quotedValues: [],
    metricRefs: finding.relatedMetrics,
  };
  return {
    finding,
    composed,
    rank: rankOf(finding, composed),
    status: deriveStatus(finding),
  };
}

function rankOf(finding: Finding, _composed: ComposedStory): number {
  const severity = SEVERITY_RANK[finding.severity];
  const meta = finding.sourceFindings ? 100 : 0;
  const cohort = Math.min(finding.subjects.length, 50);
  return meta + severity * 10 + cohort;
}

function deriveStatus(finding: Finding): StoryStatus {
  if (finding.severity === "action") return "slipping";
  if (finding.key.includes("ready")) return "ready_to_ship";
  if (finding.key.includes("improvement")) return "working";
  return "watching";
}

function rankAndDedupe(stories: RankedStory[], cap: number): RankedStory[] {
  const sorted = [...stories].sort((a, b) => b.rank - a.rank);
  const seen = new Set<string>();
  const kept: RankedStory[] = [];
  for (const s of sorted) {
    const dedupeKey = s.composed.title.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    kept.push(s);
    if (kept.length >= cap) break;
  }
  return kept;
}

function enforceSinglePriority(stories: RankedStory[]): RankedStory[] {
  // Promote the first action-severity story (highest rank wins because
  // the input is already ranked descending). Meta-stories carry a +100
  // rank boost, so a meta-action story will always win promotion over
  // an atomic action story.
  const promoteIdx = stories.findIndex((s) => s.finding.severity === "action");
  if (promoteIdx === -1) return stories;
  return stories.map((s, i) =>
    i === promoteIdx ? { ...s, status: "priority" as const } : s,
  );
}

async function persistStories(
  ctx: ProjectionContext,
  stories: RankedStory[],
): Promise<StoryRow[]> {
  if (!ctx.locale.trim()) {
    throw new Error("Story projection requires a locale");
  }
  await ensureStoryTable(ctx.db);

  const rows: StoryRow[] = stories.map((s, i) => ({
    id: generateId(),
    org: ctx.org,
    locale: ctx.locale,
    key: s.finding.key,
    status: s.status,
    severity: s.finding.severity,
    title: s.composed.title,
    body: s.composed.body,
    rank: stories.length - i,
    subjects: s.finding.subjects,
    data: s.finding.data,
    metricRefs: s.composed.metricRefs,
    quotedValues: s.composed.quotedValues,
    modelName: s.finding.sourceFindings ? "meta-detector" : "atomic-detector",
    sourceFindingKeys: s.finding.sourceFindings?.map((f) => f.key) ?? [],
    periodEnd: ctx.period.end,
    createdAt: ctx.now,
  }));

  // pg driver doesn't auto-stringify arrays for jsonb columns. Stringify
  // every JSON column explicitly so the same insert path works whether
  // the value happens to be an object or array.
  const insertRows = rows.map((r) => ({
    ...r,
    subjects: JSON.stringify(r.subjects),
    data: JSON.stringify(r.data),
    metricRefs: JSON.stringify(r.metricRefs),
    quotedValues: JSON.stringify(r.quotedValues),
    sourceFindingKeys: JSON.stringify(r.sourceFindingKeys),
  }));
  await ctx.db.transaction(async (trx) => {
    if (isPostgres(trx)) {
      const identity = JSON.stringify([
        ctx.org,
        ctx.locale,
        ctx.period.end.toISOString(),
      ]);
      await trx.raw(
        "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
        [identity],
      );
    }

    if (ctx.locale !== "und") {
      await trx(STORY_TABLE)
        .where("org", ctx.org)
        .where("locale", "und")
        .where("periodEnd", ctx.period.end)
        .delete();
    }

    await trx(STORY_TABLE)
      .where("org", ctx.org)
      .where("locale", ctx.locale)
      .where("periodEnd", ctx.period.end)
      .delete();
    if (insertRows.length > 0) {
      await trx(STORY_TABLE).insert(insertRows);
    }
  });
  return rows;
}

function isPostgres(db: Knex | Knex.Transaction): boolean {
  const client = String(db.client.config.client ?? "");
  return client === "pg" || client.includes("postgres");
}
