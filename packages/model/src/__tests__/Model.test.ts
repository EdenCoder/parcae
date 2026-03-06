import { describe, it, expect, beforeEach } from "vitest";
import { Model, generateId } from "../Model";
import type { ModelAdapter, ChangeSet, QueryChain } from "../adapters/types";

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
    save: async (model: any, changes: ChangeSet) => {
      adapter.saved.push({ model, changes });
    },
    remove: async (model: any) => {
      adapter.removed.push(model);
    },
    findById: async () => null,
    query: () => ({}) as QueryChain<any>,
    patch: async (model: any, ops: any[]) => {
      adapter.patched.push({ model, ops });
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
      const post = new Post(adapter, {
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
      const post = new Post(adapter, { id: "abc", title: "Partial" });
      expect(post.title).toBe("Partial");
      expect(post.body).toBe("");
      expect(post.published).toBe(false);
      expect(post.views).toBe(0);
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

  describe("change tracking", async () => {
    it("should track changes after construction", async () => {
      const post = Post.create({ title: "Original" });
      // Wait for microtask to flip SYM_IS_PROXY
      await new Promise((r) => setTimeout(r, 10));
      post.title = "Changed";
      expect(post.title).toBe("Changed");
      expect(post.__updates).toContain("title");
    });

    it("should NOT track property defaults as changes", () => {
      const post = Post.create({ title: "Hello" });
      // __updates should be empty — nothing changed since creation
      expect(post.__updates).toEqual([]);
    });
  });

  describe("save", () => {
    it("should call adapter.save with changes", async () => {
      const post = Post.create({ title: "New Post" });
      await post.save(true);
      expect(adapter.saved.length).toBe(1);
      expect(adapter.saved[0].changes.creating).toBe(true);
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
