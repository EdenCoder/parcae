import { describe, it, expect, vi } from "vitest";
import { searchAll } from "../search";
import type { BackendAdapter } from "../adapters/model";

// ─── Mock Helpers ────────────────────────────────────────────────────────────

function createMockModel(
  type: string,
  opts: {
    searchFields?: string[];
    scope?: any;
    items?: any[];
  } = {},
): any {
  return {
    type,
    searchFields: opts.searchFields,
    scope: opts.scope,
    __schema: {},
  };
}

function createMockItem(
  type: string,
  data: Record<string, any>,
  rank?: number,
): any {
  return {
    ...data,
    type,
    _rank: rank,
    sanitize: async () => ({ type, ...data }),
  };
}

function createMockAdapter(
  resultsMap: Record<string, any[]> = {},
): BackendAdapter {
  const adapter: any = {
    query: (modelClass: any) => {
      const chain: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "find") {
              return async () => resultsMap[modelClass.type] || [];
            }
            return (..._args: any[]) => chain;
          },
        },
      );
      return chain;
    },
  };
  return adapter;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("searchAll", () => {
  describe("basic functionality", () => {
    it("should return empty array for empty term", async () => {
      const adapter = createMockAdapter();
      const result = await searchAll(adapter, "", {
        models: [createMockModel("project", { searchFields: ["title"] })],
      });
      expect(result).toEqual([]);
    });

    it("should return empty array for whitespace-only term", async () => {
      const adapter = createMockAdapter();
      const result = await searchAll(adapter, "   ", {
        models: [createMockModel("project", { searchFields: ["title"] })],
      });
      expect(result).toEqual([]);
    });

    it("should skip models without searchFields", async () => {
      const ProjectModel = createMockModel("project", {
        searchFields: ["title"],
      });
      const SettingModel = createMockModel("setting"); // no searchFields

      const adapter = createMockAdapter({
        project: [createMockItem("project", { title: "Test" }, 5)],
        setting: [createMockItem("setting", { key: "color" }, 1)],
      });

      const result = await searchAll(adapter, "test", {
        models: [ProjectModel, SettingModel],
      });

      // Only project results, not settings
      expect(result.length).toBe(1);
      expect(result[0]!.type).toBe("project");
    });

    it("should return results from multiple models sorted by rank", async () => {
      const ProjectModel = createMockModel("project", {
        searchFields: ["title"],
      });
      const UserModel = createMockModel("user", {
        searchFields: ["name"],
      });

      const adapter = createMockAdapter({
        project: [createMockItem("project", { title: "Low Match" }, 2)],
        user: [createMockItem("user", { name: "High Match" }, 8)],
      });

      const result = await searchAll(adapter, "match", {
        models: [ProjectModel, UserModel],
      });

      expect(result.length).toBe(2);
      // Higher rank first
      expect(result[0]!.type).toBe("user");
      expect(result[0]!.rank).toBe(8);
      expect(result[1]!.type).toBe("project");
      expect(result[1]!.rank).toBe(2);
    });
  });

  describe("scope handling", () => {
    it("should deny access when scope returns null", async () => {
      const ProjectModel = createMockModel("project", {
        searchFields: ["title"],
        scope: {
          read: () => null, // denied
        },
      });

      const adapter = createMockAdapter({
        project: [createMockItem("project", { title: "Secret" }, 10)],
      });

      const result = await searchAll(adapter, "secret", {
        models: [ProjectModel],
        scope: { user: null },
      });

      expect(result).toEqual([]);
    });

    it("should apply scope function when provided", async () => {
      const scopeFn = vi.fn(() => (qb: any) => qb.where("public", true));
      const ProjectModel = createMockModel("project", {
        searchFields: ["title"],
        scope: { read: scopeFn },
      });

      const adapter = createMockAdapter({
        project: [createMockItem("project", { title: "Public" }, 5)],
      });

      await searchAll(adapter, "public", {
        models: [ProjectModel],
        scope: { user: { id: "u1" } },
      });

      expect(scopeFn).toHaveBeenCalledWith({ user: { id: "u1" } });
    });

    it("should work without scope (public access)", async () => {
      const ProjectModel = createMockModel("project", {
        searchFields: ["title"],
        // no scope defined
      });

      const adapter = createMockAdapter({
        project: [createMockItem("project", { title: "Open" }, 3)],
      });

      const result = await searchAll(adapter, "open", {
        models: [ProjectModel],
      });

      expect(result.length).toBe(1);
    });
  });

  describe("limit handling", () => {
    it("should respect custom limit", async () => {
      const ProjectModel = createMockModel("project", {
        searchFields: ["title"],
      });

      const items = Array.from({ length: 20 }, (_, i) =>
        createMockItem("project", { title: `Item ${i}` }, 20 - i),
      );

      const adapter = createMockAdapter({ project: items });

      const result = await searchAll(adapter, "item", {
        models: [ProjectModel],
        limit: 5,
      });

      expect(result.length).toBe(5);
    });

    it("should use default limit of 10", async () => {
      const ProjectModel = createMockModel("project", {
        searchFields: ["title"],
      });

      const items = Array.from({ length: 15 }, (_, i) =>
        createMockItem("project", { title: `Item ${i}` }, 15 - i),
      );

      const adapter = createMockAdapter({ project: items });

      const result = await searchAll(adapter, "item", {
        models: [ProjectModel],
      });

      expect(result.length).toBe(10);
    });
  });

  describe("error handling", () => {
    it("should not crash when a model query fails", async () => {
      const ProjectModel = createMockModel("project", {
        searchFields: ["title"],
      });
      const BrokenModel = createMockModel("broken", {
        searchFields: ["name"],
      });

      const adapter: any = {
        query: (modelClass: any) => {
          if (modelClass.type === "broken") {
            const chain: any = new Proxy(
              {},
              {
                get(_t, prop: string) {
                  if (prop === "find") {
                    return async () => {
                      throw new Error("table does not exist");
                    };
                  }
                  return (..._args: any[]) => chain;
                },
              },
            );
            return chain;
          }
          const chain: any = new Proxy(
            {},
            {
              get(_t, prop: string) {
                if (prop === "find") {
                  return async () => [
                    createMockItem("project", { title: "Works" }, 5),
                  ];
                }
                return (..._args: any[]) => chain;
              },
            },
          );
          return chain;
        },
      };

      const result = await searchAll(adapter, "test", {
        models: [ProjectModel, BrokenModel],
      });

      // Should still get project results despite broken model failing
      expect(result.length).toBe(1);
      expect(result[0]!.type).toBe("project");
    });
  });

  describe("result shape", () => {
    it("should return results with correct shape", async () => {
      const ProjectModel = createMockModel("project", {
        searchFields: ["title"],
      });

      const adapter = createMockAdapter({
        project: [
          createMockItem("project", { title: "My Project", id: "p1" }, 7.5),
        ],
      });

      const result = await searchAll(adapter, "project", {
        models: [ProjectModel],
      });

      expect(result.length).toBe(1);
      expect(result[0]!).toEqual({
        type: "project",
        item: { type: "project", title: "My Project", id: "p1" },
        rank: 7.5,
      });
    });

    it("should use position-based rank when _rank is missing", async () => {
      const ProjectModel = createMockModel("project", {
        searchFields: ["title"],
      });

      const adapter = createMockAdapter({
        project: [
          createMockItem("project", { title: "First" }), // no _rank
          createMockItem("project", { title: "Second" }),
        ],
      });

      const result = await searchAll(adapter, "test", {
        models: [ProjectModel],
      });

      // Position-based: first item gets length - 0 = 2, second gets length - 1 = 1
      expect(result[0]!.rank).toBe(2);
      expect(result[1]!.rank).toBe(1);
    });
  });
});
