/**
 * "First save IS a create" — hooks registered for 'save' must also
 * fire when the adapter dispatches 'create' for a brand-new row.
 * Without the alias, create-only flows (toggle rows: likes, follows,
 * bookmarks) silently bypass every save hook — validation and counter
 * hooks alike. Regression coverage for the registration-side alias.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelConstructor } from "@parcae/model";
import { clearHooks, getHooksFor, hook } from "../routing/hook";

const TestModel = {
  type: "aliastest",
  __schema: { name: "string" },
} as unknown as ModelConstructor;

afterEach(() => {
  clearHooks();
});

describe("save → create alias", () => {
  it("a 'save' registration matches both save and create dispatches", () => {
    hook.after(TestModel, "save", vi.fn());

    expect(getHooksFor("aliastest", "after", "save")).toHaveLength(1);
    expect(getHooksFor("aliastest", "after", "create")).toHaveLength(1);
  });

  it("applies to before hooks too (validation must gate creates)", () => {
    hook.before(TestModel, "save", vi.fn());

    expect(getHooksFor("aliastest", "before", "create")).toHaveLength(1);
  });

  it("a 'create' registration stays create-only", () => {
    hook.after(TestModel, "create", vi.fn());

    expect(getHooksFor("aliastest", "after", "create")).toHaveLength(1);
    expect(getHooksFor("aliastest", "after", "save")).toHaveLength(0);
  });

  it("other actions are not aliased", () => {
    hook.after(TestModel, "patch", vi.fn());
    hook.after(TestModel, "remove", vi.fn());

    expect(getHooksFor("aliastest", "after", "create")).toHaveLength(0);
    expect(getHooksFor("aliastest", "after", "patch")).toHaveLength(1);
    expect(getHooksFor("aliastest", "after", "remove")).toHaveLength(1);
  });

  it("a hook registered for save runs once per create dispatch", () => {
    const handler = vi.fn();
    hook.after(TestModel, "save", handler);

    const entries = getHooksFor("aliastest", "after", "create");
    expect(entries).toHaveLength(1);
    // Same entry serves both actions — no duplicate registrations.
    expect(entries[0]).toBe(getHooksFor("aliastest", "after", "save")[0]);
  });
});
