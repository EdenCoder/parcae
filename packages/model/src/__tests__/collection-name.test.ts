import { describe, it, expect } from "vitest";
import { Model } from "../Model";
import { FrontendAdapter, type Transport } from "../adapters/client";

// ─── Recording transport ──────────────────────────────────────────────────────
//
// Captures the path each RPC method is invoked with, and returns a
// canned payload so we can assert how the adapter both BUILDS the
// request URL and READS the list-response envelope key.

function createRecordingTransport(getResult: any = null): Transport & {
  calls: { method: string; path: string }[];
} {
  const calls: { method: string; path: string }[] = [];
  const record = (method: string) => async (path: string) => {
    calls.push({ method, path });
    return method === "get" ? getResult : { id: "x" };
  };
  return {
    calls,
    get: record("get"),
    post: record("post"),
    put: record("put"),
    patch: record("patch"),
    delete: record("delete"),
  };
}

// ─── Models whose plural is NOT `type + "s"` ───────────────────────────────────
//
// These are the cases where the old naive `${type}s` URL builder
// diverged from the backend's `pluralize(type)` route and 404'd.

class Category extends Model {
  static type = "category" as const; // → categories
}
class Person extends Model {
  static type = "person" as const; // → people
}
class Status extends Model {
  static type = "status" as const; // → statuses
}
class Settings extends Model {
  static type = "settings" as const; // → settings (already plural)
}
class Post extends Model {
  static type = "post" as const; // → posts (regular — must stay unchanged)
}
class Custom extends Model {
  static type = "thing" as const;
  static path = "/v1/custom-things"; // explicit override wins
}

// `stripVersion` strips the leading `/v1`, so the recorded path is the
// collection segment the backend route resolves to.
const cases: [typeof Model, string][] = [
  [Category, "/categories"],
  [Person, "/people"],
  [Status, "/statuses"],
  [Settings, "/settings"],
  [Post, "/posts"],
];

describe("collection-name parity (SDK ↔ backend route)", () => {
  for (const [ModelClass, expectedPath] of cases) {
    it(`builds the pluralized URL for "${ModelClass.type}"`, async () => {
      const transport = createRecordingTransport();
      const adapter = new FrontendAdapter(transport);
      await adapter.findById(ModelClass as any, "abc");
      expect(transport.calls[0]?.path).toBe(`${expectedPath}/abc`);
    });
  }

  it("honours an explicit static path over pluralisation", async () => {
    const transport = createRecordingTransport();
    const adapter = new FrontendAdapter(transport);
    await adapter.findById(Custom as any, "abc");
    expect(transport.calls[0]?.path).toBe("/custom-things/abc");
  });

  it("reads the list envelope under the pluralized key", async () => {
    const transport = createRecordingTransport({
      categories: [{ id: "1" }, { id: "2" }],
    });
    const adapter = new FrontendAdapter(transport);
    const rows = await adapter.query(Category as any).find();
    expect(transport.calls[0]?.path).toBe("/categories");
    expect(rows.map((r: any) => r.id)).toEqual(["1", "2"]);
  });

  it("falls back to the naive `${type}s` key for an older backend", async () => {
    // A newer SDK against a backend that still emits the naive key.
    const transport = createRecordingTransport({
      categorys: [{ id: "9" }],
    });
    const adapter = new FrontendAdapter(transport);
    const rows = await adapter.query(Category as any).find();
    expect(rows.map((r: any) => r.id)).toEqual(["9"]);
  });
});
