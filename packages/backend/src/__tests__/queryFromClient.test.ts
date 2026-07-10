import { describe, it, expect, beforeEach } from "vitest";
import knexFactory from "knex";
import { BackendAdapter } from "../adapters/model";
import type { QueryStep, SchemaDefinition } from "@parcae/model";

// ─── Mock Model Class ────────────────────────────────────────────────────────

function createMockModel(type: string, schema: SchemaDefinition): any {
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

  function makeChain(isRoot = true): any {
    return new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === "find") return async () => [];
          if (prop === "first") return async () => null;
          if (prop === "count") return async () => 0;
          if (prop === "exec") return () => ({});
          if (prop === "clone") return () => makeChain();
          return (...args: any[]) => {
            if (
              isRoot &&
              prop === "where" &&
              typeof args[0] === "function"
            ) {
              args[0](makeChain(false));
              return makeChain();
            }
            calls[calls.length] = { method: prop, args };
            return makeChain(isRoot);
          };
        },
      },
    );
  }

  const adapter = new (BackendAdapter as any)({
    read: () => {},
    write: () => {},
  });
  // Override query() to return our recording chain
  adapter.query = () => makeChain();

  return { adapter: adapter as BackendAdapter, calls };
}

// ─── Test Schema ─────────────────────────────────────────────────────────────

const ProjectModel = createMockModel("project", {
  name: "string",
  status: "string",
  userId: "string",
  views: "integer",
  tags: "json",
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("BackendAdapter.queryFromClient", () => {
  let adapter: BackendAdapter;
  let calls: Array<{ method: string; args: any[] }>;

  beforeEach(() => {
    const test = createTestAdapter();
    adapter = test.adapter;
    calls = test.calls;
  });

  // ── Basic Replay ──────────────────────────────────────────────────

  describe("basic step replay", () => {
    it("should apply scope first, even with no client steps", () => {
      adapter.queryFromClient(ProjectModel, { userId: "u1" }, undefined);

      // First call after query() should be where(scope)
      expect(calls[0]).toEqual({ method: "where", args: [{ userId: "u1" }] });
    });

    it("should inject default limit when client sends none", () => {
      adapter.queryFromClient(ProjectModel, { userId: "u1" }, []);

      const limitCall = calls.find((c) => c.method === "limit");
      expect(limitCall).toBeDefined();
      expect(limitCall!.args[0]).toBe(25);
    });

    it("should replay where, orderBy, limit, offset", () => {
      const steps: QueryStep[] = [
        { method: "where", args: [{ status: "active" }] },
        { method: "orderBy", args: ["createdAt", "desc"] },
        { method: "limit", args: [10] },
        { method: "offset", args: [20] },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      // scope first
      expect(calls[0]).toEqual({ method: "where", args: [{ userId: "u1" }] });
      // then client steps
      expect(calls[1]).toEqual({
        method: "where",
        args: [{ status: "active" }],
      });
      expect(calls[2]).toEqual({
        method: "orderBy",
        args: ["createdAt", "desc"],
      });
      expect(calls[3]).toEqual({ method: "limit", args: [10] });
      expect(calls[4]).toEqual({ method: "offset", args: [20] });
    });

    it("should replay select with valid columns", () => {
      const steps: QueryStep[] = [
        { method: "select", args: ["id", "name", "status"] },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      expect(calls[1]).toEqual({
        method: "select",
        args: ["id", "name", "status"],
      });
    });

    it("should replay 3-arg where with operator", () => {
      const steps: QueryStep[] = [
        { method: "where", args: ["views", ">=", 100] },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      expect(calls[1]).toEqual({
        method: "where",
        args: ["views", ">=", 100],
      });
    });

    it("should replay whereIn", () => {
      const steps: QueryStep[] = [
        { method: "whereIn", args: ["status", ["active", "draft"]] },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      expect(calls[1]).toEqual({
        method: "whereIn",
        args: ["status", ["active", "draft"]],
      });
    });

    it("should replay whereNull and whereNotNull", () => {
      const steps: QueryStep[] = [
        { method: "whereNull", args: ["tags"] },
        { method: "whereNotNull", args: ["name"] },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      expect(calls[1]).toEqual({ method: "whereNull", args: ["tags"] });
      expect(calls[2]).toEqual({ method: "whereNotNull", args: ["name"] });
    });
  });

  // ── Limit Sanitization ────────────────────────────────────────────
  //
  // No upper clamp on client-provided limits since commit ba22391 —
  // the scope is the security boundary. Client `.limit(N)` passes
  // through verbatim, coerced to a positive integer, falling back to
  // DEFAULT_LIMIT (25) on parse failure.

  describe("limit sanitization", () => {
    it("should pass large client limits through verbatim (no upper clamp)", () => {
      const steps: QueryStep[] = [{ method: "limit", args: [500] }];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const limitCall = calls.find((c) => c.method === "limit");
      expect(limitCall!.args[0]).toBe(500);
    });

    it("should treat limit(0) as default (0 is not a valid limit)", () => {
      const steps: QueryStep[] = [{ method: "limit", args: [0] }];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const limitCall = calls.find((c) => c.method === "limit");
      // parseInt(0) || 25 → 25, then Math.max(25, 1) → 25
      expect(limitCall!.args[0]).toBe(25);
    });

    it("should handle non-numeric limit gracefully", () => {
      const steps: QueryStep[] = [{ method: "limit", args: ["garbage"] }];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const limitCall = calls.find((c) => c.method === "limit");
      // NaN → default 25, then Math.max(25, 1) → 25
      expect(limitCall!.args[0]).toBe(25);
    });

    it("should not inject default limit if client provides one", () => {
      const steps: QueryStep[] = [{ method: "limit", args: [50] }];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const limitCalls = calls.filter((c) => c.method === "limit");
      expect(limitCalls.length).toBe(1);
      expect(limitCalls[0]!.args[0]).toBe(50);
    });
  });

  // ── Column Validation ─────────────────────────────────────────────

  describe("column validation", () => {
    it("should throw on invalid column in where (string arg)", () => {
      const steps: QueryStep[] = [
        { method: "where", args: ["secretField", "hack"] },
      ];

      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps),
      ).toThrow('Invalid column "secretField"');
    });

    it("should throw on invalid column in where (object arg)", () => {
      const steps: QueryStep[] = [
        { method: "where", args: [{ secretField: "hack" }] },
      ];

      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps),
      ).toThrow('Invalid column "secretField"');
    });

    it("should throw on invalid column in select", () => {
      const steps: QueryStep[] = [
        { method: "select", args: ["id", "passwordHash"] },
      ];

      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps),
      ).toThrow('Invalid column "passwordHash"');
    });

    it("should throw on invalid column in orderBy", () => {
      const steps: QueryStep[] = [
        { method: "orderBy", args: ["internalScore", "desc"] },
      ];

      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps),
      ).toThrow('Invalid column "internalScore"');
    });

    it("should throw on invalid column in whereIn", () => {
      const steps: QueryStep[] = [
        { method: "whereIn", args: ["role", ["admin", "superadmin"]] },
      ];

      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps),
      ).toThrow('Invalid column "role"');
    });

    it("should allow system columns (id, createdAt, updatedAt)", () => {
      const steps: QueryStep[] = [
        { method: "where", args: ["id", "abc"] },
        { method: "orderBy", args: ["createdAt", "desc"] },
        { method: "select", args: ["id", "updatedAt"] },
      ];

      // Should not throw
      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps),
      ).not.toThrow();
    });

    it("should allow select *", () => {
      const steps: QueryStep[] = [{ method: "select", args: ["*"] }];

      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps),
      ).not.toThrow();
    });
  });

  // ── Operator Validation ───────────────────────────────────────────

  describe("operator validation", () => {
    it("should allow safe operators", () => {
      // `not like` / `not ilike` are the negative complements of
      // `like` / `ilike` — same pattern surface, no extra attack
      // surface. Necessary for predicates like
      // `WHERE path NOT LIKE 'http%'` (aura: local-vs-streamed
      // filter on the Scenes page).
      const safeOps = [
        "=",
        "!=",
        "<>",
        "<",
        ">",
        "<=",
        ">=",
        "like",
        "ilike",
        "not like",
        "not ilike",
      ];

      for (const op of safeOps) {
        const t = createTestAdapter();
        expect(() =>
          t.adapter.queryFromClient(ProjectModel, { userId: "u1" }, [
            { method: "where", args: ["views", op, 10] },
          ]),
        ).not.toThrow();
      }
    });

    it("should reject dangerous operators", () => {
      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, [
          { method: "where", args: ["name", "SIMILAR TO", ".*"] },
        ]),
      ).toThrow("Invalid operator");
    });
  });

  // ── Method Allowlist ──────────────────────────────────────────────

  describe("method allowlist", () => {
    it("should silently skip dangerous methods", () => {
      const steps: QueryStep[] = [
        { method: "join", args: ["users", "users.id", "projects.userId"] },
        { method: "whereRaw", args: ["1=1; DROP TABLE users;--"] },
        { method: "from", args: ["users"] },
        { method: "groupBy", args: ["userId"] },
        { method: "increment", args: ["views", 1] },
        { method: "where", args: [{ status: "active" }] }, // only this should survive
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      // scope + the one valid where + default limit
      const methods = calls.map((c) => c.method);
      expect(methods).not.toContain("join");
      expect(methods).not.toContain("whereRaw");
      expect(methods).not.toContain("from");
      expect(methods).not.toContain("groupBy");
      expect(methods).not.toContain("increment");
      expect(methods).toContain("where");
    });

    it("should skip orderByRaw", () => {
      const steps: QueryStep[] = [{ method: "orderByRaw", args: ["RANDOM()"] }];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const methods = calls.map((c) => c.method);
      expect(methods).not.toContain("orderByRaw");
    });
  });

  // ── Nested Builder Callbacks ──────────────────────────────────────

  describe("nested builder (__nested)", () => {
    it("should reconstruct nested where as a callback", () => {
      const steps: QueryStep[] = [
        {
          method: "where",
          args: [
            {
              __nested: [
                { method: "where", args: ["status", "active"] },
                { method: "orWhere", args: ["status", "draft"] },
              ],
            },
          ],
        },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      // The where call should have a function as its first arg
      const nestedCall = calls[1]!;
      expect(nestedCall.method).toBe("where");
      expect(typeof nestedCall.args[0]).toBe("function");

      // Invoke the callback with a mock builder to verify it replays correctly
      const builderCalls: any[] = [];
      const mockBuilder: any = new Proxy(
        {},
        {
          get:
            (_t, method: string) =>
            (...args: any[]) => {
              builderCalls.push({ method, args });
              return mockBuilder;
            },
        },
      );

      nestedCall.args[0](mockBuilder);

      expect(builderCalls).toEqual([
        { method: "where", args: ["status", "active"] },
        { method: "orWhere", args: ["status", "draft"] },
      ]);
    });

    it("should validate columns inside nested builders", () => {
      const steps: QueryStep[] = [
        {
          method: "where",
          args: [
            {
              __nested: [{ method: "where", args: ["secretField", "hack"] }],
            },
          ],
        },
      ];

      // queryFromClient creates the callback, validation happens when invoked
      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const nestedCall = calls[1]!;
      const mockBuilder: any = new Proxy(
        {},
        {
          get:
            (_t, _method: string) =>
            (..._args: any[]) =>
              mockBuilder,
        },
      );

      expect(() => nestedCall.args[0](mockBuilder)).toThrow(
        'Invalid column "secretField"',
      );
    });

    it("should skip dangerous methods inside nested builders", () => {
      const steps: QueryStep[] = [
        {
          method: "where",
          args: [
            {
              __nested: [
                { method: "where", args: ["status", "active"] },
                { method: "whereRaw", args: ["1=1"] },
                { method: "join", args: ["users"] },
              ],
            },
          ],
        },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const nestedCall = calls[1]!;
      const builderCalls: any[] = [];
      const mockBuilder: any = new Proxy(
        {},
        {
          get:
            (_t, method: string) =>
            (...args: any[]) => {
              builderCalls.push({ method, args });
              return mockBuilder;
            },
        },
      );

      nestedCall.args[0](mockBuilder);

      // Only the safe `where` should have been replayed
      expect(builderCalls.length).toBe(1);
      expect(builderCalls[0].method).toBe("where");
    });
  });

  // ── Input Normalization ───────────────────────────────────────────

  describe("input normalization", () => {
    it("should handle undefined rawSteps", () => {
      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, undefined),
      ).not.toThrow();
    });

    it("should handle JSON string rawSteps", () => {
      const steps: QueryStep[] = [
        { method: "where", args: [{ status: "active" }] },
      ];

      adapter.queryFromClient(
        ProjectModel,
        { userId: "u1" },
        JSON.stringify(steps),
      );

      expect(calls[1]).toEqual({
        method: "where",
        args: [{ status: "active" }],
      });
    });

    it("should throw on malformed JSON string", () => {
      expect(() =>
        adapter.queryFromClient(
          ProjectModel,
          { userId: "u1" },
          "not-valid-json",
        ),
      ).toThrow("malformed JSON");
    });

    it("should handle empty array", () => {
      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, []),
      ).not.toThrow();
    });
  });

  // ── Adversarial / Security ────────────────────────────────────────

  describe("adversarial: SQL injection via method names", () => {
    it("should ignore steps with fabricated method names", () => {
      const steps: QueryStep[] = [
        { method: "raw", args: ["DROP TABLE projects; --"] },
        { method: "whereRaw", args: ["1=1; DROP TABLE users; --"] },
        { method: "orWhereRaw", args: ["1=1"] },
        { method: "havingRaw", args: ["COUNT(*) > 0; DROP TABLE files; --"] },
        {
          method: "orderByRaw",
          args: ["(SELECT password FROM users LIMIT 1)"],
        },
        { method: "groupByRaw", args: ["1; DROP TABLE sessions; --"] },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const methods = calls.map((c) => c.method);
      // Only scope where + default limit should be present
      expect(methods).toEqual(["where", "limit"]);
    });

    it("should ignore completely bogus method names", () => {
      const steps: QueryStep[] = [
        { method: "__proto__", args: [] },
        { method: "constructor", args: [] },
        { method: "toString", args: [] },
        { method: "exec", args: [] },
        { method: "then", args: [] },
        { method: "toSQL", args: [] },
        { method: "truncate", args: [] },
        { method: "del", args: [] },
        { method: "delete", args: [] },
        { method: "insert", args: [{ id: "hack", name: "injected" }] },
        { method: "update", args: [{ name: "hacked" }] },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const methods = calls.map((c) => c.method);
      expect(methods).toEqual(["where", "limit"]);
    });
  });

  describe("adversarial: SQL injection via column names", () => {
    it("should reject column names with SQL injection in where", () => {
      const attacks = [
        "name; DROP TABLE projects; --",
        "1=1 OR 1=1",
        "name' OR '1'='1",
        'name" OR "1"="1',
        "name UNION SELECT * FROM users --",
      ];

      for (const col of attacks) {
        const t = createTestAdapter();
        expect(() =>
          t.adapter.queryFromClient(ProjectModel, { userId: "u1" }, [
            { method: "where", args: [col, "value"] },
          ]),
        ).toThrow("Invalid column");
      }
    });

    it("should reject column names with SQL injection in select", () => {
      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, [
          { method: "select", args: ["id", "name; DROP TABLE users; --"] },
        ]),
      ).toThrow("Invalid column");
    });

    it("should reject column names with SQL injection in orderBy", () => {
      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, [
          { method: "orderBy", args: ["(SELECT 1)", "desc"] },
        ]),
      ).toThrow("Invalid column");
    });
  });

  describe("adversarial: SQL injection via operators", () => {
    it("should reject subquery-style operators", () => {
      const badOps = [
        "= ANY(SELECT id FROM users)",
        "IN (SELECT id FROM users)",
        "; DROP TABLE users; --",
        "SIMILAR TO",
        "~",
        "~*",
        "!~",
        "!~*",
      ];

      for (const op of badOps) {
        const t = createTestAdapter();
        expect(() =>
          t.adapter.queryFromClient(ProjectModel, { userId: "u1" }, [
            { method: "where", args: ["name", op, "test"] },
          ]),
        ).toThrow("Invalid operator");
      }
    });
  });

  describe("adversarial: join/from bypass attempts", () => {
    it("should not allow join to read other tables", () => {
      const steps: QueryStep[] = [
        { method: "join", args: ["users", "users.id", "=", "projects.userId"] },
        { method: "select", args: ["id", "name"] },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const methods = calls.map((c) => c.method);
      expect(methods).not.toContain("join");
      expect(methods).not.toContain("innerJoin");
      expect(methods).not.toContain("leftJoin");
      expect(methods).not.toContain("rightJoin");
    });

    it("should not allow from to switch tables", () => {
      const steps: QueryStep[] = [
        { method: "from", args: ["users"] },
        { method: "select", args: ["*"] },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const methods = calls.map((c) => c.method);
      expect(methods).not.toContain("from");
    });

    it("should not allow whereExists with subquery", () => {
      const steps: QueryStep[] = [
        {
          method: "whereExists",
          args: ["SELECT 1 FROM users WHERE admin = true"],
        },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const methods = calls.map((c) => c.method);
      expect(methods).not.toContain("whereExists");
    });
  });

  describe("adversarial: mutation attempts", () => {
    it("should not allow increment/decrement", () => {
      const steps: QueryStep[] = [
        { method: "increment", args: ["views", 999999] },
        { method: "decrement", args: ["views", 999999] },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const methods = calls.map((c) => c.method);
      expect(methods).not.toContain("increment");
      expect(methods).not.toContain("decrement");
    });
  });

  describe("adversarial: scope bypass attempts", () => {
    it("should always apply scope even if client sends conflicting where", () => {
      const steps: QueryStep[] = [
        // Attacker tries to override the scope userId
        { method: "where", args: [{ userId: "other-user-id" }] },
      ];

      adapter.queryFromClient(
        ProjectModel,
        { userId: "legitimate-user" },
        steps,
      );

      // Scope where must come FIRST, then client where
      expect(calls[0]).toEqual({
        method: "where",
        args: [{ userId: "legitimate-user" }],
      });
      expect(calls[1]).toEqual({
        method: "where",
        args: [{ userId: "other-user-id" }],
      });
      // Both wheres are ANDed by Knex — scope is never overridden
    });

    it("keeps a tenant scope ANDed with a top-level client OR in generated SQL", async () => {
      const knex = knexFactory({ client: "pg" });
      const sqlAdapter = new BackendAdapter({ read: knex, write: knex });

      try {
        const query = sqlAdapter.queryFromClient(
          ProjectModel,
          { userId: "tenant-user" },
          [
            { method: "where", args: ["status", "active"] },
            { method: "orWhere", args: ["userId", "attacker-user"] },
            { method: "orderBy", args: ["createdAt", "desc"] },
            { method: "limit", args: [10] },
          ],
        );
        const compiled = (query as any).exec().toSQL();

        expect(compiled.sql).toContain(
          'where "userId" = ? and ("status" = ? or "userId" = ?)',
        );
        expect(compiled.sql).toContain('order by "createdAt" desc limit ?');
        expect(compiled.bindings).toEqual([
          "tenant-user",
          "active",
          "attacker-user",
          10,
        ]);
      } finally {
        await knex.destroy();
      }
    });

    it("should not allow client to remove scope via clearSelect/clearOrder", () => {
      const steps: QueryStep[] = [
        { method: "clearSelect", args: [] },
        { method: "clearOrder", args: [] },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const methods = calls.map((c) => c.method);
      expect(methods).not.toContain("clearSelect");
      expect(methods).not.toContain("clearOrder");
    });
  });

  describe("adversarial: nested builder injection", () => {
    it("should block join inside nested builder", () => {
      const steps: QueryStep[] = [
        {
          method: "where",
          args: [
            {
              __nested: [
                {
                  method: "join",
                  args: ["users", "users.id", "projects.userId"],
                },
                { method: "where", args: ["status", "active"] },
              ],
            },
          ],
        },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const nestedCall = calls[1]!;
      const builderCalls: any[] = [];
      const mockBuilder: any = new Proxy(
        {},
        {
          get:
            (_t: any, method: string) =>
            (...args: any[]) => {
              builderCalls.push({ method, args });
              return mockBuilder;
            },
        },
      );

      nestedCall.args[0](mockBuilder);

      // join should be stripped, only where should survive
      expect(builderCalls).toHaveLength(1);
      expect(builderCalls[0].method).toBe("where");
    });

    it("should block whereRaw inside nested builder", () => {
      const steps: QueryStep[] = [
        {
          method: "where",
          args: [
            {
              __nested: [
                { method: "whereRaw", args: ["1=1; DROP TABLE users; --"] },
              ],
            },
          ],
        },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const nestedCall = calls[1]!;
      const builderCalls: any[] = [];
      const mockBuilder: any = new Proxy(
        {},
        {
          get:
            (_t: any, method: string) =>
            (...args: any[]) => {
              builderCalls.push({ method, args });
              return mockBuilder;
            },
        },
      );

      nestedCall.args[0](mockBuilder);

      expect(builderCalls).toHaveLength(0);
    });

    it("should reject invalid columns inside nested builder", () => {
      const steps: QueryStep[] = [
        {
          method: "where",
          args: [
            {
              __nested: [{ method: "where", args: ["password", "=", "admin"] }],
            },
          ],
        },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const nestedCall = calls[1]!;
      const mockBuilder: any = new Proxy(
        {},
        {
          get:
            (_t: any, _method: string) =>
            (..._args: any[]) =>
              mockBuilder,
        },
      );

      expect(() => nestedCall.args[0](mockBuilder)).toThrow(
        'Invalid column "password"',
      );
    });

    it("should reject invalid operators inside nested builder", () => {
      const steps: QueryStep[] = [
        {
          method: "where",
          args: [
            {
              __nested: [
                { method: "where", args: ["name", "SIMILAR TO", ".*admin.*"] },
              ],
            },
          ],
        },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const nestedCall = calls[1]!;
      const mockBuilder: any = new Proxy(
        {},
        {
          get:
            (_t: any, _method: string) =>
            (..._args: any[]) =>
              mockBuilder,
        },
      );

      expect(() => nestedCall.args[0](mockBuilder)).toThrow("Invalid operator");
    });

    it("should block deeply nested injection (nested within nested)", () => {
      const steps: QueryStep[] = [
        {
          method: "where",
          args: [
            {
              __nested: [
                {
                  method: "where",
                  args: [
                    {
                      __nested: [
                        {
                          method: "whereRaw",
                          args: ["1=1; DROP TABLE users;--"],
                        },
                        { method: "join", args: ["users"] },
                        { method: "where", args: ["status", "active"] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      // Outer nested → calls[1] is where(callback)
      const outerCall = calls[1]!;
      const outerBuilderCalls: any[] = [];
      let innerCallback: any = null;

      const outerMockBuilder: any = new Proxy(
        {},
        {
          get:
            (_t: any, method: string) =>
            (...args: any[]) => {
              outerBuilderCalls.push({ method, args });
              if (typeof args[0] === "function") innerCallback = args[0];
              return outerMockBuilder;
            },
        },
      );

      outerCall.args[0](outerMockBuilder);

      // The outer nested had one step: where(__nested) → should produce where(callback)
      expect(outerBuilderCalls).toHaveLength(1);
      expect(outerBuilderCalls[0].method).toBe("where");
      expect(typeof outerBuilderCalls[0].args[0]).toBe("function");

      // Now invoke the inner callback
      const innerBuilderCalls: any[] = [];
      const innerMockBuilder: any = new Proxy(
        {},
        {
          get:
            (_t: any, method: string) =>
            (...args: any[]) => {
              innerBuilderCalls.push({ method, args });
              return innerMockBuilder;
            },
        },
      );

      innerCallback(innerMockBuilder);

      // Only the safe where("status", "active") should survive
      expect(innerBuilderCalls).toHaveLength(1);
      expect(innerBuilderCalls[0]).toEqual({
        method: "where",
        args: ["status", "active"],
      });
    });
  });

  describe("adversarial: prototype pollution", () => {
    it("should not crash on __proto__ in where object", () => {
      const malicious = JSON.parse(
        '{"__proto__": {"isAdmin": true}, "status": "active"}',
      );
      const steps: QueryStep[] = [{ method: "where", args: [malicious] }];

      // __proto__ is not a valid column, should throw
      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps),
      ).toThrow("Invalid column");
    });

    it("should not crash on constructor in where object", () => {
      const steps: QueryStep[] = [
        { method: "where", args: [{ constructor: "hack" }] },
      ];

      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps),
      ).toThrow("Invalid column");
    });
  });

  describe("adversarial: DoS via limit/offset", () => {
    it("should pass absurdly large limits through (scope is the DoS boundary, not the limit)", () => {
      // No upper clamp since ba22391 — the scope already restricts
      // which rows the client can see. A naked `Number.MAX_SAFE_INTEGER`
      // here just becomes whatever the SQL driver does with it, which
      // is bounded by the actual scoped row count.
      const steps: QueryStep[] = [
        { method: "limit", args: [Number.MAX_SAFE_INTEGER] },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const limitCall = calls.find((c) => c.method === "limit");
      expect(limitCall!.args[0]).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("should handle negative limit", () => {
      const steps: QueryStep[] = [{ method: "limit", args: [-1] }];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const limitCall = calls.find((c) => c.method === "limit");
      // -1 → parseInt(-1) = -1 || 25 → still -1 (truthy), Math.max(-1, 1) → 1
      expect(limitCall!.args[0]).toBe(1);
    });

    it("should handle Infinity limit", () => {
      const steps: QueryStep[] = [{ method: "limit", args: [Infinity] }];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const limitCall = calls.find((c) => c.method === "limit");
      // parseInt(Infinity) → NaN, NaN || 25 → 25, then Math.max(25, 1) → 25
      expect(limitCall!.args[0]).toBe(25);
    });
  });

  describe("clearLimit", () => {
    it("should bypass default limit and set 10,000 ceiling", () => {
      const steps: QueryStep[] = [{ method: "clearLimit", args: [] }];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const limitCall = calls.find((c) => c.method === "limit");
      expect(limitCall).toBeDefined();
      expect(limitCall!.args[0]).toBe(10_000);
    });

    it("should allow explicit limit after clearLimit without clamping", () => {
      const steps: QueryStep[] = [
        { method: "clearLimit", args: [] },
        { method: "limit", args: [500] },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const limitCalls = calls.filter((c) => c.method === "limit");
      // clearLimit sets 10,000, then explicit limit sets 500 unclamped
      expect(limitCalls).toHaveLength(2);
      expect(limitCalls[0]!.args[0]).toBe(10_000);
      expect(limitCalls[1]!.args[0]).toBe(500);
    });

    it("should not clamp large limit when clearLimit is present", () => {
      const steps: QueryStep[] = [
        { method: "clearLimit", args: [] },
        { method: "limit", args: [5000] },
      ];

      adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps);

      const limitCalls = calls.filter((c) => c.method === "limit");
      expect(limitCalls[1]!.args[0]).toBe(5000);
    });
  });

  describe("adversarial: malformed step payloads", () => {
    it("should handle step with missing args", () => {
      const steps = [{ method: "where" }] as any;

      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps),
      ).not.toThrow();
    });

    it("should handle step with null args", () => {
      const steps: QueryStep[] = [{ method: "where", args: null as any }];

      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps),
      ).not.toThrow();
    });

    it("should handle step with non-array args", () => {
      const steps = [{ method: "limit", args: "50" }] as any;

      // Non-array args → spread will fail, but we guard with ?? []
      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps),
      ).not.toThrow();
    });

    it("should handle __nested with non-array value", () => {
      const steps: QueryStep[] = [
        {
          method: "where",
          args: [{ __nested: "not-an-array" }],
        },
      ];

      // __nested is not an array → treated as regular object where
      // "not-an-array" is a string, not array, so Array.isArray fails
      // Falls through to object check → tries to validate "__nested" as column
      expect(() =>
        adapter.queryFromClient(ProjectModel, { userId: "u1" }, steps),
      ).toThrow("Invalid column");
    });
  });

  // ── whereIn on JSON-array columns ─────────────────────────────────
  //
  // The schema resolver collapses both `string[]` and arbitrary objects
  // into the same `"json"` ColumnType. queryFromClient additionally
  // probes a fresh model instance and remembers which `json` columns
  // are runtime arrays so it can dispatch `whereIn` correctly:
  //
  //   - scalar / `{}` json columns → native `WHERE col IN (?, ?)`
  //   - `string[]` json columns    → "array contains any of these"
  //                                  via `@>` (Postgres) or LIKE
  //                                  (SQLite). Without this, callers
  //                                  who write the natural
  //                                  `Scene.whereIn("tags", [tagId])`
  //                                  silently match nothing.
  describe("whereIn on JSON-array columns", () => {
    // Real class so `new ModelClass()` works (the helper probes the
    // runtime default value of each json column to learn array-ness).
    class ProjectArrayModel {
      static type = "project_array";
      static __schema: SchemaDefinition = {
        name: "string",
        userId: "string",
        // Both declared as `json` in the schema — the difference is
        // only visible by inspecting the instance default below.
        tags: "json",
        metadata: "json",
      };
      name = "";
      userId = "";
      tags: string[] = []; // ← Array.isArray default → array column
      metadata: any = null; // ← null default → object/any column
    }

    it("emits @> containment SQL on Postgres for json-array columns", () => {
      const steps: QueryStep[] = [
        { method: "whereIn", args: ["tags", ["a", "b"]] },
      ];

      adapter.queryFromClient(
        ProjectArrayModel as any,
        { userId: "u1" },
        steps,
      );

      const whereRaw = calls.find((c) => c.method === "whereRaw");
      expect(whereRaw).toBeDefined();
      expect(whereRaw!.args[0]).toContain("@>");
      // One @> clause per value, OR'd together.
      expect((whereRaw!.args[0].match(/@>/g) ?? []).length).toBe(2);
      expect(whereRaw!.args[1]).toEqual([
        "tags",
        '["a"]',
        "tags",
        '["b"]',
      ]);
      // Native whereIn must NOT be called for this column.
      const nativeWhereIn = calls.find(
        (c) =>
          c.method === "whereIn" &&
          Array.isArray(c.args[0])
            ? false
            : c.args[0] === "tags",
      );
      expect(nativeWhereIn).toBeUndefined();
    });

    it("emits LIKE containment SQL on SQLite for json-array columns", () => {
      (adapter as any).engine = "sqlite";

      const steps: QueryStep[] = [
        { method: "whereIn", args: ["tags", ["a"]] },
      ];

      adapter.queryFromClient(
        ProjectArrayModel as any,
        { userId: "u1" },
        steps,
      );

      const whereRaw = calls.find((c) => c.method === "whereRaw");
      expect(whereRaw).toBeDefined();
      expect(whereRaw!.args[0]).toContain("LIKE");
      expect(whereRaw!.args[0]).not.toContain("@>");
      // Surrounding quotes pin the LIKE to a literal JSON-array
      // element — without them prefix/suffix collisions across ids
      // would false-positive.
      expect(whereRaw!.args[1]).toEqual(["tags", '%"a"%']);
    });

    it("falls through to native whereIn for scalar columns", () => {
      const steps: QueryStep[] = [
        { method: "whereIn", args: ["userId", ["u1", "u2"]] },
      ];

      adapter.queryFromClient(
        ProjectArrayModel as any,
        { userId: "u1" },
        steps,
      );

      // Should see a native whereIn call (the second one — the first
      // is the scope where).
      const whereInCall = calls.find(
        (c) => c.method === "whereIn" && c.args[0] === "userId",
      );
      expect(whereInCall).toBeDefined();
      expect(whereInCall!.args).toEqual(["userId", ["u1", "u2"]]);
    });

    it("dispatches to @> for any json column — the schema doesn't track array-ness", () => {
      // `metadata` is `metadata: any = null` on the model, but the
      // schema resolver records its type as `"json"` either way.
      // Schema-only dispatch treats any json column as a containment
      // candidate; whereIn-against-an-object is a meaningless shape
      // the caller is responsible for not building.
      const steps: QueryStep[] = [
        { method: "whereIn", args: ["metadata", ["x"]] },
      ];

      adapter.queryFromClient(
        ProjectArrayModel as any,
        { userId: "u1" },
        steps,
      );

      const whereRaw = calls.find((c) => c.method === "whereRaw");
      expect(whereRaw).toBeDefined();
      expect(whereRaw!.args[0]).toContain("@>");
      const nativeWhereIn = calls.find(
        (c) => c.method === "whereIn" && c.args[0] === "metadata",
      );
      expect(nativeWhereIn).toBeUndefined();
    });

    it("emits a hard-false predicate for an empty values array", () => {
      const steps: QueryStep[] = [
        { method: "whereIn", args: ["tags", []] },
      ];

      adapter.queryFromClient(
        ProjectArrayModel as any,
        { userId: "u1" },
        steps,
      );

      const whereRaw = calls.find((c) => c.method === "whereRaw");
      expect(whereRaw).toBeDefined();
      expect(whereRaw!.args[0]).toBe("1 = 0");
    });
  });
});
