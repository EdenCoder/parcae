import { afterEach, describe, expect, it, vi } from "vitest";
import { Model, SYM_SERVER_PATCH, flushChangeEmits } from "@parcae/model";
import { effect, signal } from "@preact/signals-core";

import { field, settled } from "../signals";

class Post extends Model {
  static type = "post" as const;
  title = "";
  meta: Record<string, unknown> = {};
}

const adapter: any = { save: async () => {}, patch: async () => {}, remove: async () => {}, query: () => ({}), findById: async () => null };

describe("signals", () => {
  afterEach(() => vi.useRealTimers());

  it("a field moves only when its own value moves", () => {
    const post = Post.hydrate(adapter, { id: "p1", title: "before", meta: { theme: "light" } });
    const seen: unknown[] = [];
    const stop = effect(() => {
      seen.push(field(post, "meta.theme").value);
    });

    post[SYM_SERVER_PATCH]([{ op: "replace", path: "/title", value: "after" }]);
    flushChangeEmits();
    post.stage([{ op: "replace", path: "/meta/theme", value: "dark" }]);

    expect(seen).toEqual(["light", "dark"]);
    stop();
  });

  it("a settled signal moves once per window, to the latest value", () => {
    vi.useFakeTimers();
    const source = signal(0);
    const quiet = settled(source);
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(quiet.value);
    });

    source.value = 1;
    source.value = 2;
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([0, 2]);
    source.value = 3;
    vi.advanceTimersByTime(490);
    expect(seen).toEqual([0, 2]);
    vi.advanceTimersByTime(20);

    expect(seen).toEqual([0, 2, 3]);
    stop();
  });
});
