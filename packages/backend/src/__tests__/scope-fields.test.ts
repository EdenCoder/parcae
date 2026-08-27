/**
 * `scope.fields` — per-field query policy. Covers the shapes a column
 * can arrive in: bare name, object predicate, nested builder, and ref
 * dot-notation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { BackendAdapter } from "../adapters/model";
import { prepareClientQuery } from "../services/query-subscription";
import { ClientError } from "../helpers";
import type { QueryStep } from "@parcae/model";
import {
  createMockModel,
  createTestAdapter,
  registerTestModels,
} from "./adapter-test";

// Open read scope with two withheld columns.
const UserModel = createMockModel(
  "user",
  { name: "string", email: "string", role: "string" },
  {
    scope: {
      read: () => () => {},
      fields: {
        email: (ctx: any) => !!ctx.user,
        role: (ctx: any) => !!ctx.user,
      },
    },
  },
);

const ANON = { user: null, params: {}, data: {} };
const SIGNED_IN = { user: { id: "u1" }, params: {}, data: {} };

describe("scope.fields — direct column references", () => {
  let adapter: BackendAdapter;

  beforeEach(() => {
    adapter = createTestAdapter({ invoke: "all" }).adapter;
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
    // Same class, same message — a withheld column can't be told apart
    // from one that was never declared.
    const expected = (col: string) =>
      new ClientError(`Invalid column "${col}" on model "user"`);
    expect(() => run([{ method: "where", args: ["email", "a@b.c"] }], ANON)) //
      .toThrow(expected("email"));
    expect(() => run([{ method: "where", args: ["nope", "x"] }], ANON)) //
      .toThrow(expected("nope"));
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
    const Open = createMockModel("open", { email: "string" }, {
      scope: { read: () => () => {} },
    });
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
    // Denies outright rather than evaluating against an empty ctx —
    // this predicate is TRUE for `{}` and would otherwise sail through.
    const FailOpen = createMockModel("failopen", { secret: "string" }, {
      scope: {
        read: () => () => {},
        fields: { secret: (c: any) => c.user?.role !== "banned" },
      },
    });
    expect(() =>
      (adapter as any).queryFromClient(FailOpen, {}, [
        { method: "where", args: ["secret", "x"] },
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
    adapter = createTestAdapter({ invoke: "all" }).adapter;
    // Register User so the ref target resolves out of the registry.
    registerTestModels(adapter, { user: UserModel });
  });

  const PostModel = createMockModel("post", {
    title: "string",
    author: { kind: "ref", target: UserModel },
  } as any);

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

  it("exempts server-side chains, which carry no client policy", () => {
    // `_buildQuery` ref-hops with no policy argument. Trusted code must
    // not inherit a restriction meant for client replay.
    expect(() =>
      (adapter as any)._rewriteRefDotNotation(
        { method: "where", args: ["author.email", "x"] },
        ["author.email", "x"],
        PostModel.__schema,
      ),
    ).not.toThrow();
  });
});

describe("scope.fields — aggregate columns", () => {
  // `__sum` names a column outside the step list, so the replay never
  // sees it. `prepareClientQuery` surfaces the same denied set the
  // steps were gated on, and routes.ts folds it into its numeric check.
  it("surfaces the denied set for routes that validate their own column", () => {
    const { adapter } = createTestAdapter({ invoke: "all" });
    const prep = (ctx: any) =>
      prepareClientQuery({
        ModelClass: UserModel,
        scopeResult: {},
        rawSteps: [],
        modelByType: new Map([["user", UserModel]]),
        adapter,
        ctx,
      });

    expect([...prep(ANON).denied].sort()).toEqual(["email", "role"]);
    expect([...prep(SIGNED_IN).denied]).toEqual([]);
  });

  it("reports nothing denied for a model with no policy", () => {
    const { adapter } = createTestAdapter({ invoke: "all" });
    const Open = createMockModel("open", { views: "integer" }, {
      scope: { read: () => () => {} },
    });
    const prep = prepareClientQuery({
      ModelClass: Open,
      scopeResult: {},
      rawSteps: [],
      modelByType: new Map([["open", Open]]),
      adapter,
      ctx: ANON,
    });
    expect(prep.denied.size).toBe(0);
  });
});
