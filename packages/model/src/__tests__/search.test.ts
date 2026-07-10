import { describe, it, expect, beforeEach } from "vitest";
import { Model } from "../Model";
import type { ModelAdapter } from "../adapters/types";

// ─── Mock Adapter ────────────────────────────────────────────────────────────

function createMockAdapter(): ModelAdapter & { lastQuery: any } {
  const adapter: any = {
    lastQuery: null,
    save: async () => {},
    remove: async () => {},
    findById: async () => null,
    query: (modelClass: any) => {
      const steps: any[] = [];
      function makeChain(): any {
        return new Proxy(
          {},
          {
            get(_target, prop: string) {
              if (prop === "__steps") return steps;
              if (prop === "__modelType") return modelClass.type;
              if (prop === "__modelClass") return modelClass;
              if (prop === "__adapter") return adapter;
              return (...args: any[]) => {
                steps.push({ method: prop, args });
                return makeChain();
              };
            },
          },
        );
      }
      adapter.lastQuery = makeChain();
      return adapter.lastQuery;
    },
    patch: async () => {},
  };
  return adapter;
}

// ─── Test Models ─────────────────────────────────────────────────────────────

class Article extends Model {
  static type = "article" as const;
  static searchFields = ["title", "body"];
  title: string = "";
  body: string = "";
  published: boolean = false;
}

class Tag extends Model {
  static type = "tag" as const;
  // No searchFields
  name: string = "";
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Model.search() — lazy query chain", () => {
  const adapter = createMockAdapter();

  beforeEach(() => {
    adapter.lastQuery = null;
    Model.use(adapter);
  });

  describe("search() chain method", () => {
    it("should record a search step in the lazy query chain", () => {
      const chain = Article.search("ghost town");
      expect(chain.__steps).toBeDefined();
      expect(chain.__steps.length).toBe(1);
      expect(chain.__steps[0]).toEqual({
        method: "search",
        args: ["ghost town"],
      });
    });

    it("should record search step with correct model type", () => {
      const chain = Article.search("test");
      expect(chain.__modelType).toBe("article");
    });

    it("should chain with other query methods", () => {
      const chain = Article.where({ published: true })
        .search("hello world")
        .orderBy("createdAt", "desc")
        .limit(10);

      expect(chain.__steps.length).toBe(4);
      expect(chain.__steps[0]).toEqual({
        method: "where",
        args: [{ published: true }],
      });
      expect(chain.__steps[1]).toEqual({
        method: "search",
        args: ["hello world"],
      });
      expect(chain.__steps[2]).toEqual({
        method: "orderBy",
        args: ["createdAt", "desc"],
      });
      expect(chain.__steps[3]).toEqual({
        method: "limit",
        args: [10],
      });
    });

    it("should work as the only step", () => {
      const chain = Article.search("query");
      expect(chain.__steps).toEqual([{ method: "search", args: ["query"] }]);
    });

    it("should handle empty search term", () => {
      const chain = Article.search("");
      expect(chain.__steps).toEqual([{ method: "search", args: [""] }]);
    });

    it("should be callable on models without searchFields", () => {
      // .search() is on QueryChain, not gated by searchFields
      // The backend handles the no-op when searchFields is absent
      const chain = Tag.search("test");
      expect(chain.__steps).toEqual([{ method: "search", args: ["test"] }]);
    });
  });

  describe("search() immutability", () => {
    it("should not mutate the original chain", () => {
      const base = Article.where({ published: true });
      const withSearch = base.search("test");
      const withLimit = withSearch.limit(5);

      expect(base.__steps.length).toBe(1);
      expect(withSearch.__steps.length).toBe(2);
      expect(withLimit.__steps.length).toBe(3);
    });
  });
});
