import { describe, it, expect, beforeEach } from "vitest";
import { Model, generateId } from "../Model";
import type { ModelAdapter, QueryChain } from "../adapters/types";

// ─── Mock Adapter ────────────────────────────────────────────────────────────

function createMockAdapter(): ModelAdapter & {
  saved: any[];
  removed: any[];
  patched: any[];
} {
  const adapter = {
    saved: [] as any[],
    removed: [] as any[],
    patched: [] as any[],
    createStore: (data: Record<string, any>) => ({ ...data }),
    save: async (model: any) => {
      adapter.saved.push({ model, data: { ...model.__data } });
    },
    remove: async (model: any) => {
      adapter.removed.push(model);
    },
    findById: async () => null,
    query: () => ({}) as QueryChain<any>,
    patch: async (model: any, ops: any[]) => {
      adapter.patched.push({ model, ops: [...ops] });
    },
  };
  return adapter;
}

// ─── Test Model ──────────────────────────────────────────────────────────────

class Post extends Model {
  static type = "post" as const;
  title: string = "";
  body: string = "";
  published: boolean = false;
  views: number = 0;
}

class Comment extends Model {
  static type = "comment" as const;
  text: string = "";
  author: string = "";
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Model", () => {
  let adapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    adapter = createMockAdapter();
    Model.use(adapter);
  });

  describe("class property defaults", () => {
    it("should use defaults when created empty", () => {
      const post = Post.create();
      expect(post.title).toBe("");
      expect(post.body).toBe("");
      expect(post.published).toBe(false);
      expect(post.views).toBe(0);
    });

    it("should NOT overwrite provided data with defaults", () => {
      const post = Post.create({ title: "Hello", published: true, views: 42 });
      expect(post.title).toBe("Hello");
      expect(post.published).toBe(true);
      expect(post.views).toBe(42);
      expect(post.body).toBe(""); // default for unprovided field
    });
  });

  describe("hydration (from adapter)", () => {
    it("should preserve all provided data", () => {
      const post = Post.hydrate(adapter, {
        id: "abc",
        title: "From DB",
        body: "Content",
        published: true,
        views: 100,
      });
      expect(post.id).toBe("abc");
      expect(post.title).toBe("From DB");
      expect(post.body).toBe("Content");
      expect(post.published).toBe(true);
      expect(post.views).toBe(100);
    });

    it("should use defaults for missing fields", () => {
      const post = Post.hydrate(adapter, { id: "abc", title: "Partial" });
      expect(post.title).toBe("Partial");
      expect(post.body).toBe("");
      expect(post.published).toBe(false);
      expect(post.views).toBe(0);
    });

    it("should NOT mark hydrated instances as new", () => {
      const post = Post.hydrate(adapter, { id: "abc", title: "x" });
      expect(post.__isNew).toBe(false);
    });

    it("seeds the server snapshot from the hydrated data", async () => {
      const post = Post.hydrate(adapter, {
        id: "abc",
        title: "server title",
      });
      // No local changes → flush should be a no-op.
      await post.flush();
      expect(adapter.patched.length).toBe(0);
    });
  });

  describe("__data getter", () => {
    it("should return all data properties", () => {
      const post = Post.create({ title: "Test", views: 5 });
      const data = post.__data;
      expect(data.title).toBe("Test");
      expect(data.views).toBe(5);
      expect(data.body).toBe("");
      expect(data.published).toBe(false);
      expect(data.id).toBeDefined();
      expect(data.type).toBe("post");
      expect(data.createdAt).toBeDefined();
      expect(data.updatedAt).toBeDefined();
    });

    it("should not include internal symbols", () => {
      const post = Post.create();
      const data = post.__data;
      const keys = Object.keys(data);
      expect(keys.every((k) => !k.startsWith("Symbol"))).toBe(true);
    });
  });

  describe("direct writes", () => {
    it("are retained on the instance without any tracking", () => {
      const post = Post.create({ title: "Original" });
      post.title = "Changed";
      expect(post.title).toBe("Changed");
    });

    it("do NOT emit 'change'", () => {
      const post = Post.create();
      let fired = 0;
      post.on("change", () => fired++);
      post.title = "hello";
      post.views = 10;
      expect(fired).toBe(0);
    });
  });

  describe("save", () => {
    it("sends the full current state to the adapter", async () => {
      const post = Post.create({ title: "New Post" });
      await post.save();
      expect(adapter.saved.length).toBe(1);
      expect(adapter.saved[0].data.title).toBe("New Post");
    });

    it("clears __isNew after a successful save", async () => {
      const post = Post.create({ title: "Hi" });
      expect(post.__isNew).toBe(true);
      await post.save();
      expect(post.__isNew).toBe(false);
    });

    it("refreshes the server snapshot so flush becomes a no-op", async () => {
      const post = Post.create({ title: "A" });
      await post.save();
      // Nothing changed locally since save — flush should be a no-op.
      await post.flush();
      expect(adapter.patched.length).toBe(0);
    });
  });

  describe("flush", () => {
    it("routes to save() when the instance is still __isNew", async () => {
      const post = Post.create({ title: "Brand new" });
      await post.flush();
      expect(adapter.saved.length).toBe(1);
      expect(adapter.patched.length).toBe(0);
    });

    it("sends only the diff as RFC 6902 ops after direct writes", async () => {
      const post = Post.create({ title: "orig" });
      await post.save();
      post.title = "next";
      post.views = 7;
      await post.flush();
      expect(adapter.patched.length).toBe(1);
      const ops = adapter.patched[0].ops;
      const byPath: Record<string, any> = {};
      for (const op of ops) byPath[op.path] = op;
      expect(byPath["/title"]).toMatchObject({ op: "replace", value: "next" });
      expect(byPath["/views"]).toMatchObject({ op: "replace", value: 7 });
    });

    it("is a no-op when nothing has changed", async () => {
      const post = Post.create({ title: "nothing changes" });
      await post.save();
      await post.flush();
      await post.flush();
      expect(adapter.patched.length).toBe(0);
    });

    it("emits 'change' via its inner patch() call", async () => {
      const post = Post.create({ title: "a" });
      await post.save();
      let fired = 0;
      post.on("change", () => fired++);
      post.title = "b";
      await post.flush();
      expect(fired).toBe(1);
    });

    it("strips system-managed keys (id / type / createdAt / updatedAt / tmp) from the diff", async () => {
      const post = Post.create({ title: "a" });
      await post.save();
      adapter.patched.length = 0;

      // Simulate the backend mutating updatedAt to a fresh Date after
      // save — which is what our BackendAdapter does. If we didn't
      // strip it, `fast-json-patch.compare` would emit garbage char-
      // level ops for the Date, and the adapter would reject them as
      // an unknown column.
      (post as any).updatedAt = new Date();
      post.title = "b";
      await post.flush();

      expect(adapter.patched.length).toBe(1);
      const paths = adapter.patched[0].ops.map((o: any) => o.path);
      expect(paths).toContain("/title");
      expect(paths.some((p: string) => p.startsWith("/updatedAt"))).toBe(false);
      expect(paths.some((p: string) => p.startsWith("/createdAt"))).toBe(false);
      expect(paths.some((p: string) => p.startsWith("/id"))).toBe(false);
      expect(paths.some((p: string) => p.startsWith("/type"))).toBe(false);
    });

    it("is still a no-op when only system fields differ", async () => {
      const post = Post.create({ title: "a" });
      await post.save();
      adapter.patched.length = 0;
      (post as any).updatedAt = new Date();
      await post.flush();
      expect(adapter.patched.length).toBe(0);
    });

    it("coalesces concurrent calls into at most 2 round-trips (leading + trailing)", async () => {
      const post = Post.create({ title: "start" });
      await post.save();
      adapter.patched.length = 0;

      // Slow down the adapter's patch so the leading flush is
      // genuinely still in-flight when the follow-ups fire.
      const originalPatch = adapter.patch;
      adapter.patch = async (model: any, ops: any[]) => {
        await new Promise((r) => setTimeout(r, 10));
        return originalPatch(model, ops);
      };

      // Burst of flushes with new state each time. Streaming call
      // sites do exactly this — mutate + flush per delta.
      post.title = "a";
      const p1 = post.flush();
      post.title = "b";
      const p2 = post.flush();
      post.title = "c";
      const p3 = post.flush();
      post.title = "d";
      const p4 = post.flush();

      await Promise.all([p1, p2, p3, p4]);

      // Leading flush sends "a"; trailing coalesces b/c/d into one
      // follow-up patch with the final value.
      expect(adapter.patched.length).toBe(2);
      const lastOps = adapter.patched[1].ops;
      const lastTitle = lastOps.find((o: any) => o.path === "/title");
      expect(lastTitle?.value).toBe("d");

      // Lane clear again — next flush should be a fresh leading edge.
      adapter.patch = originalPatch;
      adapter.patched.length = 0;
      post.title = "e";
      await post.flush();
      expect(adapter.patched.length).toBe(1);
    });

    it("trailing flushes all resolve together", async () => {
      const post = Post.create({ title: "x" });
      await post.save();
      adapter.patched.length = 0;

      const originalPatch = adapter.patch;
      adapter.patch = async (model: any, ops: any[]) => {
        await new Promise((r) => setTimeout(r, 10));
        return originalPatch(model, ops);
      };

      post.title = "1";
      const p1 = post.flush();
      post.title = "2";
      const p2 = post.flush();
      post.title = "3";
      const p3 = post.flush();

      await Promise.all([p1, p2, p3]);

      expect(adapter.patched.length).toBe(2);
      adapter.patch = originalPatch;
    });
  });

  describe("patch", () => {
    it("emits 'change' synchronously on optimistic apply", async () => {
      const post = Post.create({ title: "orig" });
      await post.save();
      let fired = 0;
      post.on("change", () => fired++);
      await post.patch([{ op: "replace", path: "/title", value: "next" }]);
      expect(fired).toBe(1);
      expect(post.title).toBe("next");
    });

    it("is a no-op on an empty ops array", async () => {
      const post = Post.create({ title: "x" });
      await post.save();
      await post.patch([]);
      expect(adapter.patched.length).toBe(0);
    });

    it("updates the server snapshot so flush() won't resend the same op", async () => {
      const post = Post.create({ title: "x" });
      await post.save();
      await post.patch([{ op: "replace", path: "/title", value: "y" }]);
      adapter.patched.length = 0;
      await post.flush();
      expect(adapter.patched.length).toBe(0);
    });
  });

  describe("get / set dot-path accessors", () => {
    it("get() reads nested fields by dot-path", () => {
      const post = Post.create();
      (post as any).nested = { a: { b: "deep" } };
      expect(post.get<string>("nested.a.b")).toBe("deep");
    });

    it("get() returns undefined for missing paths", () => {
      const post = Post.create();
      expect(post.get("nope.nothing")).toBeUndefined();
    });

    it("set() writes nested fields and auto-creates intermediates", () => {
      const post = Post.create();
      post.set("nested.a.b", 42);
      expect((post as any).nested.a.b).toBe(42);
    });

    it("set() does NOT emit 'change' and does NOT call the adapter", () => {
      const post = Post.create();
      let fired = 0;
      post.on("change", () => fired++);
      post.set("title", "typed");
      expect(post.title).toBe("typed");
      expect(fired).toBe(0);
      expect(adapter.patched.length).toBe(0);
    });
  });

  describe("remove", () => {
    it("should call adapter.remove", async () => {
      const post = Post.create({ title: "Delete Me" });
      await post.remove();
      expect(adapter.removed.length).toBe(1);
    });
  });

  describe("toJSON / sanitize", () => {
    it("should serialize to plain object", () => {
      const post = Post.create({ title: "Serialize", views: 10 });
      const json = post.toJSON();
      expect(json.title).toBe("Serialize");
      expect(json.views).toBe(10);
      expect(json.type).toBe("post");
    });

    it("sanitize should return same shape", async () => {
      const post = Post.create({ title: "Sanitize" });
      const sanitized = await post.sanitize();
      expect(sanitized.title).toBe("Sanitize");
      expect(sanitized.type).toBe("post");
    });
  });

  describe("static methods", () => {
    it("generateId should return unique ids", () => {
      const a = generateId();
      const b = generateId();
      expect(a).not.toBe(b);
      expect(a.length).toBe(20);
    });

    it("hasAdapter should return true after use()", () => {
      expect(Model.hasAdapter()).toBe(true);
    });
  });

  describe("lazy query chains", () => {
    it("should build without adapter", () => {
      // Temporarily clear adapter
      const saved = (Model as any).__adapter;
      (Model as any).__adapter = null;

      // These should NOT throw — they build lazy chains
      const chain = Post.where({ published: true });
      expect(chain.__steps).toBeDefined();
      expect(chain.__modelType).toBe("post");

      const chain2 = Post.select("id", "title").orderBy("createdAt", "desc");
      expect(chain2.__steps?.length).toBe(2);

      // Restore
      (Model as any).__adapter = saved;
    });
  });
});
