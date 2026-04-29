/**
 * @parcae/analytics — Story composer
 *
 * Model-agnostic LLM wrapper. The composer's job is small: take ONE
 * `Finding` and write the clinician-facing prose for it. It only sees
 * the finding's `data` + `narrativeSeed`, not a 40k fact table.
 *
 * The wrapper is async + awaits a caller-supplied `complete()` so the
 * package itself doesn't depend on a specific SDK. Freia wires this
 * up against `@anthropic-ai/sdk` in P1 — Haiku-friendly, calls
 * parallelise, retries fall back to a faster model.
 */

import type { Finding, Severity } from "./finding.js";

export interface ComposedStory {
  /** Stable identity — pass through from the finding. */
  key: string;
  severity: Severity;
  title: string;
  body: string;
  /** Numbers the composer was allowed to cite. Whitelist for the validator. */
  quotedValues: number[];
  /** Metric keys the composer claims to be quoting. Whitelist for the validator. */
  metricRefs: string[];
}

export interface ComposeRequest {
  finding: Finding;
  /** Hard cap on body length in characters. Default 600. */
  maxBodyChars?: number;
}

export interface CompletionInput {
  systemPrompt: string;
  userPrompt: string;
  /** Optional schema hint — Anthropic JSON mode, OpenAI structured output, etc. */
  jsonMode?: boolean;
}

export type CompletionFn = (
  input: CompletionInput,
) => Promise<{ json: unknown }>;

export interface ComposerOptions {
  /** The actual LLM call. Wired by the consuming app. */
  complete: CompletionFn;
  /**
   * Optional system prompt prefix. Defaults to the clinician-tone
   * brief baked into this module. Override for org-specific voice.
   */
  systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT = `
You are writing one short story for a clinician's analytics dashboard.

Rules:
- Plain English. No statistical shorthand ("z-score", "p<0.05"). No emoji.
- ≤2 sentences for the body.
- Title is a single short clause, ≤72 chars.
- You may ONLY cite numbers present in the input data. No others.
- You may ONLY claim metric refs that are listed in input.relatedMetrics.
- Do NOT name individual patients or clinicians, only counts.
- Lead with what the clinician should do or notice, then the supporting number.

Return JSON: { "title": string, "body": string, "quotedValues": number[], "metricRefs": string[] }
`.trim();

export class StoryComposer {
  private readonly complete: CompletionFn;
  private readonly systemPrompt: string;

  constructor(opts: ComposerOptions) {
    this.complete = opts.complete;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  async compose(request: ComposeRequest): Promise<ComposedStory> {
    const { finding, maxBodyChars = 600 } = request;
    const userPrompt = JSON.stringify({
      key: finding.key,
      severity: finding.severity,
      data: finding.data,
      narrativeSeed: finding.narrativeSeed,
      relatedMetrics: finding.relatedMetrics,
      cohortSize: finding.subjects.length,
    });

    const result = await this.complete({
      systemPrompt: this.systemPrompt,
      userPrompt,
      jsonMode: true,
    });

    const parsed = parseComposed(result.json);
    return {
      key: finding.key,
      severity: finding.severity,
      title: clip(parsed.title, 72),
      body: clip(parsed.body, maxBodyChars),
      quotedValues: parsed.quotedValues,
      metricRefs: parsed.metricRefs,
    };
  }
}

function parseComposed(json: unknown): {
  title: string;
  body: string;
  quotedValues: number[];
  metricRefs: string[];
} {
  if (!json || typeof json !== "object") {
    throw new Error("composer: expected JSON object response");
  }
  const obj = json as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title : "";
  const body = typeof obj.body === "string" ? obj.body : "";
  if (!title || !body) {
    throw new Error("composer: missing title or body");
  }
  const quotedValues = Array.isArray(obj.quotedValues)
    ? obj.quotedValues.filter((v): v is number => typeof v === "number")
    : [];
  const metricRefs = Array.isArray(obj.metricRefs)
    ? obj.metricRefs.filter((v): v is string => typeof v === "string")
    : [];
  return { title, body, quotedValues, metricRefs };
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Validate that a composed story only quotes numbers / metric refs
 * present in the source finding. Returns the story if valid; throws
 * if the LLM hallucinated. The projection runner catches and drops.
 */
export function validateAgainstFinding(
  story: ComposedStory,
  finding: Finding,
): ComposedStory {
  const allowedNumbers = collectNumbers(finding.data);
  const bodyNumbers = extractNumbers(`${story.title} ${story.body}`);
  for (const n of bodyNumbers) {
    if (!nearlyOneOf(n, allowedNumbers) && !nearlyOneOf(n, story.quotedValues)) {
      throw new Error(
        `composer: prose cited ${n}, not in allowed set [${[...allowedNumbers].join(", ")}]`,
      );
    }
  }
  for (const ref of story.metricRefs) {
    if (!finding.relatedMetrics.includes(ref)) {
      throw new Error(
        `composer: claimed metric ref ${ref} not in finding.relatedMetrics`,
      );
    }
  }
  return story;
}

function collectNumbers(value: unknown, acc: Set<number> = new Set()): Set<number> {
  if (typeof value === "number" && Number.isFinite(value)) {
    acc.add(round(value));
    acc.add(Math.round(value));
  } else if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, acc);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectNumbers(v, acc);
    }
  }
  return acc;
}

// Match standalone numbers — preceded by whitespace, start-of-string,
// or a paren/bracket. Skips numbers stuck to letters via hyphen
// ("Wk-4", "T-3"), since those are labels not figures.
const NUMBER_RE = /(?:^|[\s(\[])-?\d+(?:\.\d+)?/g;

function extractNumbers(prose: string): number[] {
  const matches = prose.match(NUMBER_RE);
  if (!matches) return [];
  return matches
    .map((m) => Number(m.replace(/^[\s(\[]/, "")))
    .filter((n) => Number.isFinite(n));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function nearlyOneOf(n: number, allowed: Iterable<number>): boolean {
  for (const a of allowed) {
    if (Math.abs(a - n) < 0.05) return true;
  }
  return false;
}
