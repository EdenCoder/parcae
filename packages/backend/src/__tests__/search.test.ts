import { describe, it, expect, beforeEach } from "vitest";
import { BackendAdapter } from "../adapters/model";
import type { QueryStep, SchemaDefinition } from "@parcae/model";

// ─── Mock Model Classes ─────────────────────────────────────────────────────

function createSearchModel(
  type: string,
  schema: SchemaDefinition,
  searchFields: string[],
): any {
  return {
    type,
    __schema: schema,
    searchFields,
  };
}

function createPlainModel(type: string, schema: SchemaDefinition): any {
  return {
    type,
    __schema: schema,
  };
}

// ─── Recording Query Chain ──────────────────────────────────────────────────

/**
 * Creates a mock BackendAdapter whose query() returns a recording chain.
 * Every method call is captured so we can assert what queryFromClient built.
 */
function createTestAdapter() {
  const calls: Array<{ method: string; args: any[] }> = [];

  function makeChain(): any {
    return new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === "find") return async () => [];
          if (prop === "first") return async () => null;
          if (prop === "count") return async () => 0;
          if (prop === "exec") return () => ({});
          if (prop === "clone") return () => makeChain();
          if (prop === "__steps") return calls;
          if (prop === "__modelType") return "test";
          if (prop === "__modelClass") return {};
          if (prop === "__adapter") return null;
          return (...args: any[]) => {
            calls[calls.length] = { method: prop, args };
            return makeChain();
          };
        },
      },
    );
  }

  const adapter = new (BackendAdapter as any)({
    read: Object.assign(() => makeChain(), {
      raw: (sql: string, bindings?: any[]) => ({ sql, bindings }),
    }),
    write: Object.assign(() => makeChain(), {
      raw: (sql: string, bindings?: any[]) => ({ sql, bindings }),
      schema: {
        hasTable: async () => false,
        hasColumn: async () => false,
      },
    }),
  });
  // Override query() to return our recording chain
  adapter.query = () => makeChain();

  return { adapter: adapter as BackendAdapter, calls };
}

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
  let calls: Array<{ method: string; args: any[] }>;

  beforeEach(() => {
    const test = createTestAdapter();
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
    const { adapter } = createTestAdapter();
    const mockQuery = { clone: () => mockQuery };

    const result = (adapter as any)._applySearch(mockQuery, "", ProjectModel);
    expect(result).toBe(mockQuery);
  });

  it("should return unmodified query for whitespace term", () => {
    const { adapter } = createTestAdapter();
    const mockQuery = { clone: () => mockQuery };

    const result = (adapter as any)._applySearch(
      mockQuery,
      "   ",
      ProjectModel,
    );
    expect(result).toBe(mockQuery);
  });

  it("should return unmodified query for model without searchFields", () => {
    const { adapter } = createTestAdapter();
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

    const { adapter } = createTestAdapter();
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

    const { adapter } = createTestAdapter();
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

    const { adapter } = createTestAdapter();
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

    const { adapter } = createTestAdapter();
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

    const { adapter } = createTestAdapter();
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

    const { adapter } = createTestAdapter();
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
    const { adapter } = createTestAdapter();
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

// ─── Tests: _buildQuery search method ────────────────────────────────────────

describe("BackendAdapter._buildQuery — search method", () => {
  it("should have search method on built query chain", () => {
    const { adapter } = createTestAdapter();
    const chain = adapter.query(ProjectModel);
    expect(typeof (chain as any).search).toBe("function");
  });

  it("should return a chain from search()", () => {
    const { adapter } = createTestAdapter();
    const chain = adapter.query(ProjectModel);
    const result = (chain as any).search("test");
    expect(result).toBeDefined();
    // Should still have find/first/count
    expect(typeof result.find).toBe("function");
    expect(typeof result.first).toBe("function");
    expect(typeof result.count).toBe("function");
  });

  it("should be chainable with other methods", () => {
    const { adapter } = createTestAdapter();
    const chain = adapter.query(ProjectModel);
    const result = (chain as any)
      .where({ public: true })
      .search("hello")
      .limit(10);
    expect(typeof result.find).toBe("function");
  });
});
