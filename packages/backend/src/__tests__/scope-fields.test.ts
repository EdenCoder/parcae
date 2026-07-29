/**
 * `scope.fields` — per-field query policy. Covers the shapes a column
 * can arrive in: bare name, object predicate, nested builder, and ref
 * dot-notation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { BackendAdapter } from "../adapters/model";
import { ClientError } from "../helpers";
import type { QueryStep, SchemaDefinition } from "@parcae/model";

function createMockModel(
  type: string,
  schema: SchemaDefinition,
  scope?: any,
): any {
  return { type, __schema: schema, scope };
}

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
          if (prop === "clone") return () => makeChain();
          return (...args: any[]) => {
            // Invoke builder callbacks at every depth, as knex does.
            // `__nested` steps only validate when their callback runs.
            if (prop === "where" && typeof args[0] === "function") {
              args[0](makeChain(false));
              return makeChain(isRoot);
            }
            calls[calls.length] = { method: prop, args };
            return makeChain(isRoot);
          };
        },
      },
    );
  }

  // `read`/`write` are getters over `services`, and the ref-subquery
  // path calls `this.read(table)` — so the chain goes in here.
  const adapter = new (BackendAdapter as any)({
    read: () => makeChain(),
    write: () => makeChain(),
  });
  adapter.query = () => makeChain();

  return { adapter: adapter as BackendAdapter, calls };
}

// Open read scope with two withheld columns.
const UserModel = createMockModel(
  "user",
  { name: "string", email: "string", role: "string" },
  {
    read: () => () => {},
    fields: {
      email: (ctx: any) => !!ctx.user,
      role: (ctx: any) => !!ctx.user,
    },
  },
);

const ANON = { user: null, params: {}, data: {} };
const SIGNED_IN = { user: { id: "u1" }, params: {}, data: {} };

describe("scope.fields — direct column references", () => {
  let adapter: BackendAdapter;

  beforeEach(() => {
    ({ adapter } = createTestAdapter());
  });

  const run = (steps: QueryStep[], ctx: any) =>
    (adapter as any).queryFromClient(UserModel, {}, steps, ctx);

  it("rejects a denied column in a bare where", () => {
    expect(() =>
      run([{ method: "where", args: ["email", "a@b.c"] }], ANON),
    ).toThrow(ClientError);
  });

  it("rejects a denied column in an ilike prefix probe", () => {
    expect(() =>
      run([{ method: "where", args: ["email", "ilike", "a%"] }], ANON),
    ).toThrow(ClientError);
  });

  it("rejects a denied column in an object predicate", () => {
    expect(() =>
      run([{ method: "where", args: [{ email: "a@b.c" }] }], ANON),
    ).toThrow(ClientError);
  });

  it("rejects a denied column in whereIn and orderBy", () => {
    expect(() =>
      run([{ method: "whereIn", args: ["role", ["admin"]] }], ANON),
    ).toThrow(ClientError);
    expect(() =>
      run([{ method: "orderBy", args: ["email", "asc"] }], ANON),
    ).toThrow(ClientError);
  });

  it("rejects a denied column inside a nested builder", () => {
    expect(() =>
      run(
        [
          {
            method: "where",
            args: [
              { __nested: [{ method: "orWhere", args: ["email", "a@b.c"] }] },
            ],
          },
        ],
        ANON,
      ),
    ).toThrow(ClientError);
  });

  it("reports a denied column exactly as a nonexistent one", () => {
    const denied = (() => {
      try {
        run([{ method: "where", args: ["email", "a@b.c"] }], ANON);
      } catch (err) {
        return (err as Error).message;
      }
    })();
    const missing = (() => {
      try {
        run([{ method: "where", args: ["nope", "x"] }], ANON);
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(denied).toBe('Invalid column "email" on model "user"');
    expect(missing).toBe('Invalid column "nope" on model "user"');
  });

  it("allows the same query once the predicate passes", () => {
    expect(() =>
      run([{ method: "where", args: ["email", "a@b.c"] }], SIGNED_IN),
    ).not.toThrow();
    expect(() =>
      run([{ method: "whereIn", args: ["role", ["admin"]] }], SIGNED_IN),
    ).not.toThrow();
  });

  it("leaves unlisted columns alone for everyone", () => {
    expect(() =>
      run([{ method: "where", args: ["name", "Ada"] }], ANON),
    ).not.toThrow();
    expect(() =>
      run([{ method: "orderBy", args: ["name", "asc"] }], ANON),
    ).not.toThrow();
  });

  it("does not restrict a model that declares no field policy", () => {
    const Open = createMockModel(
      "open",
      { email: "string" },
      { read: () => () => {} },
    );
    expect(() =>
      (adapter as any).queryFromClient(
        Open,
        {},
        [{ method: "where", args: ["email", "a@b.c"] }],
        ANON,
      ),
    ).not.toThrow();
  });

  it("fails closed when no ctx is supplied", () => {
    expect(() =>
      (adapter as any).queryFromClient(UserModel, {}, [
        { method: "where", args: ["email", "a@b.c"] },
      ]),
    ).toThrow(ClientError);
  });

  it("projecting a denied column is still allowed", () => {
    // `select` is a response concern — sanitize strips it on the way out.
    expect(() =>
      run([{ method: "select", args: ["id", "name", "email"] }], ANON),
    ).not.toThrow();
  });
});

describe("scope.fields — through a ref (dot-notation)", () => {
  let adapter: BackendAdapter;

  beforeEach(() => {
    ({ adapter } = createTestAdapter());
    // Register User so the ref target resolves out of the registry.
    (adapter as any)._models.set("user", UserModel);
  });

  const PostModel = createMockModel("post", {
    title: "string",
    author: { kind: "ref", target: UserModel },
  });

  const run = (steps: QueryStep[], ctx: any) =>
    (adapter as any).queryFromClient(PostModel, {}, steps, ctx);

  it("honours the TARGET model's policy, not the queried model's", () => {
    // Post declares no policy — the denial has to come from User.
    expect(() =>
      run([{ method: "where", args: ["author.email", "ilike", "a%"] }], ANON),
    ).toThrow(ClientError);
  });

  it("allows the ref hop once the target's predicate passes", () => {
    expect(() =>
      run(
        [{ method: "where", args: ["author.email", "ilike", "a%"] }],
        SIGNED_IN,
      ),
    ).not.toThrow();
  });

  it("leaves unrestricted target columns reachable", () => {
    expect(() =>
      run([{ method: "where", args: ["author.name", "Ada"] }], ANON),
    ).not.toThrow();
  });
});
