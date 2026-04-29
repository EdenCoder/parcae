import { describe, expect, it } from "vitest";
import {
  StoryComposer,
  validateAgainstFinding,
  type ComposedStory,
  type CompletionFn,
} from "../composer.js";
import type { Finding } from "../finding.js";

const baseFinding: Finding = {
  key: "cohort.retention_improvement",
  severity: "watch",
  data: { wk4Now: 47, wk4Prev: 40, lift: 7 },
  subjects: ["p1", "p2", "p3"],
  narrativeSeed: "Wk-4 retention rose 7 points",
  relatedMetrics: ["engagement.wau", "retention.wk4"],
};

describe("StoryComposer", () => {
  it("calls the completion fn with finding data + relatedMetrics", async () => {
    let capturedUserPrompt = "";
    const complete: CompletionFn = async ({ userPrompt }) => {
      capturedUserPrompt = userPrompt;
      return {
        json: {
          title: "Retention up",
          body: "Wk-4 rose 7 points to 47%.",
          quotedValues: [7, 47],
          metricRefs: ["retention.wk4"],
        },
      };
    };
    const composer = new StoryComposer({ complete });
    const story = await composer.compose({ finding: baseFinding });
    expect(JSON.parse(capturedUserPrompt)).toMatchObject({
      key: "cohort.retention_improvement",
      relatedMetrics: ["engagement.wau", "retention.wk4"],
      cohortSize: 3,
    });
    expect(story.title).toBe("Retention up");
    expect(story.severity).toBe("watch");
  });

  it("clips title at 72 chars and body at maxBodyChars", async () => {
    const complete: CompletionFn = async () => ({
      json: {
        title: "x".repeat(200),
        body: "y".repeat(1200),
        quotedValues: [],
        metricRefs: [],
      },
    });
    const composer = new StoryComposer({ complete });
    const story = await composer.compose({
      finding: baseFinding,
      maxBodyChars: 100,
    });
    expect(story.title.length).toBeLessThanOrEqual(72);
    expect(story.body.length).toBeLessThanOrEqual(100);
  });

  it("throws on missing title or body", async () => {
    const complete: CompletionFn = async () => ({
      json: { title: "", body: "ok", quotedValues: [], metricRefs: [] },
    });
    await expect(
      new StoryComposer({ complete }).compose({ finding: baseFinding }),
    ).rejects.toThrow(/missing title or body/);
  });
});

describe("validateAgainstFinding", () => {
  it("accepts a story citing only allowed numbers + refs", () => {
    const story: ComposedStory = {
      key: baseFinding.key,
      severity: "watch",
      title: "Wk-4 retention up 7 points",
      body: "47% reached wk-4 (was 40%).",
      quotedValues: [7, 47, 40],
      metricRefs: ["retention.wk4"],
    };
    expect(() => validateAgainstFinding(story, baseFinding)).not.toThrow();
  });

  it("rejects a hallucinated number", () => {
    const story: ComposedStory = {
      key: baseFinding.key,
      severity: "watch",
      title: "Stickiness up",
      // 73 isn't in finding.data or quotedValues
      body: "Stickiness rose to 73%.",
      quotedValues: [],
      metricRefs: ["retention.wk4"],
    };
    expect(() => validateAgainstFinding(story, baseFinding)).toThrow(/73/);
  });

  it("rejects a hallucinated metric ref", () => {
    const story: ComposedStory = {
      key: baseFinding.key,
      severity: "watch",
      title: "Retention up",
      body: "Latest 47.",
      quotedValues: [47],
      metricRefs: ["onboarding.first_log"],
    };
    expect(() => validateAgainstFinding(story, baseFinding)).toThrow(
      /metric ref onboarding\.first_log/,
    );
  });
});
