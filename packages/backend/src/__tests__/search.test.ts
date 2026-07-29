import { describe, it, expect, beforeEach } from "vitest";
// Value import — the engine-detection tests build adapters directly.
import { BackendAdapter } from "../adapters/model";
import type { QueryStep, SchemaDefinition } from "@parcae/model";
import {
  createMockModel,
  createTestAdapter,
  type RecordedCall,
} from "./adapter-test";

// ─── Mock Model Classes ─────────────────────────────────────────────────────

const createSearchModel = (
  type: string,
  schema: SchemaDefinition,
  searchFields: string[],
): any => createMockModel(type, schema, { searchFields });

const createPlainModel = (type: string, schema: SchemaDefinition): any =>
  createMockModel(type, schema);

// `_applySearch` reads these off the chain while composing the query.
const testAdapter = () =>
  createTestAdapter({
    props: {
      __modelType: "test",
      __modelClass: {},
      __adapter: null,
    },
  });

// ─── Test Models ─────────────────────────────────────────────────────────────

const ProjectModel = createSearchModel(
  "project",
  {
    title: "string",
    description: "text",
    userId: "string",
    public: "boolean",
  },
  ["title", "description"],
);

const UserModel = createSearchModel(
  "user",
  {
    name: "string",
    email: "string",
  },
  ["name"],
);

const SettingModel = createPlainModel("setting", {
  key: "string",
  value: "json",
});

// ─── Tests: queryFromClient with search ─────────────────────────────────────

describe("BackendAdapter — search in queryFromClient", () => {
  let adapter: BackendAdapter;
  let calls: RecordedCall[];

  beforeEach(() => {
    const test = testAdapter();
    adapter = test.adapter;
    calls = test.calls;
  });

  it("should allow search steps in the whitelist", () => {
    const steps: QueryStep[] = [{ method: "search", args: ["ghost town"] }];

    adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

    // search should be replayed (it calls chain.search())
    const searchCall = calls.find((c) => c.method === "search");
    expect(searchCall).toBeDefined();
    expect(searchCall!.args[0]).toBe("ghost town");
  });

  it("should skip search with empty term", () => {
    const steps: QueryStep[] = [{ method: "search", args: [""] }];

    adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

    const searchCall = calls.find((c) => c.method === "search");
    expect(searchCall).toBeUndefined();
  });

  it("should skip search with whitespace-only term", () => {
    const steps: QueryStep[] = [{ method: "search", args: ["   "] }];

    adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

    const searchCall = calls.find((c) => c.method === "search");
    expect(searchCall).toBeUndefined();
  });

  it("should handle non-string search term gracefully", () => {
    const steps: QueryStep[] = [{ method: "search", args: [42] }];

    adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

    // 42 is not a string, should be skipped
    const searchCall = calls.find((c) => c.method === "search");
    expect(searchCall).toBeUndefined();
  });

  it("should combine search with other steps", () => {
    const steps: QueryStep[] = [
      { method: "where", args: [{ public: true }] },
      { method: "search", args: ["test"] },
      { method: "limit", args: [20] },
    ];

    adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

    const methods = calls.map((c) => c.method);
    // scope where, then client where, then search, then limit
    expect(methods).toContain("where");
    expect(methods).toContain("search");
    expect(methods).toContain("limit");
  });

  it("should apply scope before search", () => {
    const steps: QueryStep[] = [{ method: "search", args: ["hello"] }];

    adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

    // First call should be scope, then search
    expect(calls[0]).toEqual({
      method: "where",
      args: [{ userId: "u1" }],
    });
    const searchIdx = calls.findIndex((c) => c.method === "search");
    expect(searchIdx).toBeGreaterThan(0);
  });
});

// ─── Tests: _applySearch ─────────────────────────────────────────────────────

describe("BackendAdapter._applySearch", () => {
  it("should return unmodified query for empty term", () => {
    const { adapter } = testAdapter();
    const mockQuery = { clone: () => mockQuery };

    const result = (adapter as any)._applySearch(mockQuery, "", ProjectModel);
    expect(result).toBe(mockQuery);
  });

  it("should return unmodified query for whitespace term", () => {
    const { adapter } = testAdapter();
    const mockQuery = { clone: () => mockQuery };

    const result = (adapter as any)._applySearch(
      mockQuery,
      "   ",
      ProjectModel,
    );
    expect(result).toBe(mockQuery);
  });

  it("should return unmodified query for model without searchFields", () => {
    const { adapter } = testAdapter();
    const mockQuery = { clone: () => mockQuery };

    const result = (adapter as any)._applySearch(
      mockQuery,
      "test",
      SettingModel,
    );
    expect(result).toBe(mockQuery);
  });

  it("should call whereRaw, select, clearOrder, and orderByRaw for valid search", () => {
    const methodsCalled: string[] = [];
    const mockQuery: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (..._args: any[]) => {
            methodsCalled.push(prop);
            return mockQuery;
          };
        },
      },
    );

    const { adapter } = testAdapter();
    // Ensure adapter.write.raw is available for the select call
    (adapter as any).services = {
      read: Object.assign(() => {}, {
        raw: (sql: string, bindings?: any[]) => ({ sql, bindings }),
      }),
      write: Object.assign(() => {}, {
        raw: (sql: string, bindings?: any[]) => ({ sql, bindings }),
      }),
    };
    (adapter as any).engine = "postgres";

    (adapter as any)._applySearch(mockQuery, "ghost", ProjectModel);

    expect(methodsCalled).toContain("whereRaw");
    expect(methodsCalled).toContain("select");
    expect(methodsCalled).toContain("clearOrder");
    expect(methodsCalled).toContain("orderByRaw");
  });

  it("should include semantic search SQL when engine is alloydb", () => {
    const whereRawArgs: any[] = [];
    const mockQuery: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (...args: any[]) => {
            if (prop === "whereRaw") whereRawArgs.push(args);
            return mockQuery;
          };
        },
      },
    );

    const { adapter } = testAdapter();
    (adapter as any).services = {
      read: Object.assign(() => {}, {
        raw: (sql: string, bindings?: any[]) => ({ sql, bindings }),
      }),
      write: Object.assign(() => {}, {
        raw: (sql: string, bindings?: any[]) => ({ sql, bindings }),
      }),
    };
    (adapter as any).engine = "alloydb";
    // Mark the table as having an _embedding column
    (adapter as any)._embeddingReady = new Set(["projects"]);

    (adapter as any)._applySearch(mockQuery, "ghost", ProjectModel);

    // The whereRaw SQL should include embedding/vector references
    const sql = whereRawArgs[0]?.[0] || "";
    expect(sql).toContain("_embedding");
    expect(sql).toContain("embedding(");
  });

  it("should NOT include embedding SQL when engine is postgres", () => {
    const whereRawArgs: any[] = [];
    const mockQuery: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (...args: any[]) => {
            if (prop === "whereRaw") whereRawArgs.push(args);
            return mockQuery;
          };
        },
      },
    );

    const { adapter } = testAdapter();
    (adapter as any).services = {
      read: Object.assign(() => {}, {
        raw: (sql: string, bindings?: any[]) => ({ sql, bindings }),
      }),
      write: Object.assign(() => {}, {
        raw: (sql: string, bindings?: any[]) => ({ sql, bindings }),
      }),
    };
    (adapter as any).engine = "postgres";

    (adapter as any)._applySearch(mockQuery, "ghost", ProjectModel);

    const sql = whereRawArgs[0]?.[0] || "";
    expect(sql).not.toContain("_embedding");
    expect(sql).not.toContain("embedding(");
  });

  it("should include tsvector and trigram in whereRaw for postgres", () => {
    const whereRawArgs: any[] = [];
    const mockQuery: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (...args: any[]) => {
            if (prop === "whereRaw") whereRawArgs.push(args);
            return mockQuery;
          };
        },
      },
    );

    const { adapter } = testAdapter();
    (adapter as any).services = {
      read: Object.assign(() => {}, {
        raw: (sql: string, bindings?: any[]) => ({ sql, bindings }),
      }),
      write: Object.assign(() => {}, {
        raw: (sql: string, bindings?: any[]) => ({ sql, bindings }),
      }),
    };
    (adapter as any).engine = "postgres";

    (adapter as any)._applySearch(mockQuery, "test query", ProjectModel);

    const sql = whereRawArgs[0]?.[0] || "";
    // Should include tsvector match
    expect(sql).toContain("_search @@ websearch_to_tsquery");
    // Should include trigram match for each search field
    expect(sql).toContain("title %");
    expect(sql).toContain("description %");
  });

  it("should produce correct bindings count for postgres", () => {
    const whereRawArgs: any[] = [];
    const mockQuery: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (...args: any[]) => {
            if (prop === "whereRaw") whereRawArgs.push(args);
            return mockQuery;
          };
        },
      },
    );

    const { adapter } = testAdapter();
    (adapter as any).services = {
      read: Object.assign(() => {}, {
        raw: (sql: string, bindings?: any[]) => ({ sql, bindings }),
      }),
      write: Object.assign(() => {}, {
        raw: (sql: string, bindings?: any[]) => ({ sql, bindings }),
      }),
    };
    (adapter as any).engine = "postgres";

    (adapter as any)._applySearch(mockQuery, "test", ProjectModel);

    const bindings = whereRawArgs[0]?.[1] || [];
    // 1 for tsvector + 2 for trigram (one per search field) = 3
    expect(bindings.length).toBe(3);
    expect(bindings.every((b: any) => b === "test")).toBe(true);
  });

  it("should handle single search field model", () => {
    const whereRawArgs: any[] = [];
    const mockQuery: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (...args: any[]) => {
            if (prop === "whereRaw") whereRawArgs.push(args);
            return mockQuery;
          };
        },
      },
    );

    const { adapter } = testAdapter();
    (adapter as any).services = {
      read: Object.assign(() => {}, {
        raw: (sql: string, bindings?: any[]) => ({ sql, bindings }),
      }),
      write: Object.assign(() => {}, {
        raw: (sql: string, bindings?: any[]) => ({ sql, bindings }),
      }),
    };
    (adapter as any).engine = "postgres";

    (adapter as any)._applySearch(mockQuery, "alice", UserModel);

    const bindings = whereRawArgs[0]?.[1] || [];
    // 1 for tsvector + 1 for trigram (one field) = 2
    expect(bindings.length).toBe(2);
  });
});

// ─── Tests: Engine Detection ─────────────────────────────────────────────────

describe("BackendAdapter.detectEngine", () => {
  it("should default to postgres", () => {
    const { adapter } = testAdapter();
    expect((adapter as any).engine).toBe("postgres");
  });

  it("should detect alloydb when alloydb_scann extension is available", async () => {
    const adapter = new (BackendAdapter as any)({
      read: () => {},
      write: Object.assign(() => {}, {
        raw: async () => ({ rows: [{ has_scann: true }] }),
        schema: { hasTable: async () => false, hasColumn: async () => false },
      }),
    });

    const result = await adapter.detectEngine();
    expect(result).toBe("alloydb");
    expect(adapter.engine).toBe("alloydb");
  });

  it("should detect postgres when alloydb_scann extension is not available", async () => {
    const adapter = new (BackendAdapter as any)({
      read: () => {},
      write: Object.assign(() => {}, {
        raw: async () => ({ rows: [{ has_scann: false }] }),
        schema: { hasTable: async () => false, hasColumn: async () => false },
      }),
    });

    const result = await adapter.detectEngine();
    expect(result).toBe("postgres");
    expect(adapter.engine).toBe("postgres");
  });

  it("should fall back to postgres on error", async () => {
    const adapter = new (BackendAdapter as any)({
      read: () => {},
      write: Object.assign(() => {}, {
        raw: async () => {
          throw new Error("connection refused");
        },
        schema: { hasTable: async () => false, hasColumn: async () => false },
      }),
    });

    const result = await adapter.detectEngine();
    expect(result).toBe("postgres");
    expect(adapter.engine).toBe("postgres");
  });
});
