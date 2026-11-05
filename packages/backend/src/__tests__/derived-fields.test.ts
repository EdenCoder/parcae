/**
 * A read sends only what its `select` named: its columns, with `id`, and
 * a derived field built on the sanitized row from its `from` columns.
 * Two picks of one field read the same SQL, so they must not share a
 * cached subscription.
 */

import { describe, expect, it } from "vitest";
import { prepareClientQuery } from "../services/query-subscription";
import { projectForWire } from "../services/hydrate-expansions";
import { QuerySubscriptionManager } from "../services/subscriptions";
import { createMockModel, createTestAdapter } from "./adapter-test";

const Note = createMockModel(
  "note",
  { title: "string", body: "json" },
  {
    derivedFields: {
      parts: {
        from  : ["body"],
        kinds : ["text", "step"],
        read  : (row: Record<string, unknown>, kinds: ReadonlySet<string>) =>
          (row.body as { kind: string }[]).filter((part) => kinds.has(part.kind)),
      },
    },
  },
);

const BODY = [{ kind: "text" }, { kind: "step" }, { kind: "thinking" }];

function prepare(steps: unknown) {
  const { adapter, calls } = createTestAdapter();
  const prep = prepareClientQuery({
    ModelClass: Note,
    scopeResult: {},
    rawSteps: steps,
    modelByType: new Map([["note", Note]]),
    adapter,
  });
  return { prep, select: calls.find((call) => call.method === "select")?.args };
}

/** A cached query over one row whose SQL is the same for every pick. */
function query() {
  const row = { id: "n1", title: "Hi", body: BODY };
  const chain: any = new Proxy({}, {
    get(_target, prop: string) {
      if (prop === "__modelType") return "note";
      if (prop === "find") return async () => [{ __data: row, sanitize: () => ({ ...row }) }];
      if (prop === "count") return async () => 1;
      if (prop === "exec") return () => ({ toSQL: () => ({ sql: "SELECT id, title, body FROM notes", bindings: [] }) });
      if (prop === "clone") return () => chain;
      return () => chain;
    },
  });
  return chain;
}

describe("derived fields", () => {
  it("reads a picked field's columns and sends only what the read named", async () => {
    const { prep, select } = prepare([{ method: "select", args: ["title", "parts.text"] }]);
    expect(select).toEqual(["id", "title", "body"]);
    const sanitized = { type: "note", id: "n1", title: "Hi", body: BODY, createdAt: "now" };
    const row = await projectForWire({ sanitize: () => ({ ...sanitized }) }, null, prep.selection);
    expect(row).toEqual({ id: "n1", title: "Hi", parts: [{ kind: "text" }] });
  });

  it("takes every kind by its bare name and keeps a column the read selected", async () => {
    const { prep } = prepare([{ method: "select", args: ["body", "parts"] }]);
    const row = await projectForWire({ sanitize: () => ({ id: "n1", body: BODY }) }, null, prep.selection);
    expect(row).toEqual({ id: "n1", body: BODY, parts: [{ kind: "text" }, { kind: "step" }] });
  });

  it("refuses a kind it doesn't declare, and the field anywhere but select", () => {
    expect(() => prepare([{ method: "select", args: ["parts.thinking"] }])).toThrow(/Invalid column "parts.thinking"/);
    expect(() => prepare([{ method: "where", args: ["parts", "x"] }])).toThrow(/Invalid column "parts"/);
    expect(() => prepare([{ method: "orderBy", args: ["parts.text"] }])).toThrow();
  });

  it("caches two picks of one field apart, and one pick in any order together", async () => {
    const manager = new QuerySubscriptionManager(() => {}, { debounceMs: 0, maxWaitMs: 0 });
    const subscribe = (socketId: string, args: string[]) =>
      manager.subscribe({ socketId, query: query(), selection: prepare([{ method: "select", args }]).prep.selection });
    const text = await subscribe("s1", ["parts.text"]);
    const step = await subscribe("s2", ["parts.step"]);
    const both = await subscribe("s3", ["parts.text", "parts.step"]);
    const again = await subscribe("s4", ["parts.step", "parts.text"]);
    expect(text.hash).not.toBe(step.hash);
    expect(both.hash).toBe(again.hash);
    expect(text.items).toEqual([{ id: "n1", parts: [{ kind: "text" }] }]);
    expect(step.items).toEqual([{ id: "n1", parts: [{ kind: "step" }] }]);
  });
});
