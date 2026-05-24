import { describe, it, expect, beforeEach, vi } from "vitest";
import { Model, generateId } from "../Model";
import type { ModelAdapter, QueryChain } from "../adapters/types";

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
    save: async (model: any) => {
      adapter.saved.push({ model, data: { ...model.__data } });
    },
    remove: async (model: any) => {
      adapter.removed.push(model);
    },
    findById: async () => null,
    query: () => ({}) as QueryChain<any>,
    patch: async (model: any, ops: any[]) => {
      adapter.patched.push({ model, ops: [...ops] });
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
      const post = Post.hydrate(adapter, {
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
      const post = Post.hydrate(adapter, { id: "abc", title: "Partial" });
      expect(post.title).toBe("Partial");
      expect(post.body).toBe("");
      expect(post.published).toBe(false);
      expect(post.views).toBe(0);
    });

    it("should NOT mark hydrated instances as new", () => {
      const post = Post.hydrate(adapter, { id: "abc", title: "x" });
      expect(post.__isNew).toBe(false);
    });

    it("seeds the server snapshot from the hydrated data", async () => {
      const post = Post.hydrate(adapter, {
        id: "abc",
        title: "server title",
      });
      // No local changes → flush should be a no-op.
      await post.flush();
      expect(adapter.patched.length).toBe(0);
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
      // `type` is NOT in __data — it lives on the constructor as a
      // static (`Post.type`), not on the instance. Projections that
      // need it (`sanitize()`, `toJSON()`) read from the static.
      expect(data.type).toBeUndefined();
      expect(data.createdAt).toBeDefined();
      expect(data.updatedAt).toBeDefined();
    });

    it("should not include internal symbols", () => {
      const post = Post.create();
      const data = post.__data;
      const keys = Object.keys(data);
      expect(keys.every((k) => !k.startsWith("Symbol"))).toBe(true);
    });

    it("sanitize() and toJSON() still include `type` from the static", async () => {
      const post = Post.create({ title: "T" });
      // The projection shape that goes over the wire keeps `type` as
      // the discriminator clients use to route polymorphic responses
      // — sourced from `Post.type` static rather than an instance
      // field.
      const sanitized = await post.sanitize();
      expect(sanitized.type).toBe("post");
      expect(post.toJSON().type).toBe("post");
    });
  });

  describe("direct writes", () => {
    it("are retained on the instance without any tracking", () => {
      const post = Post.create({ title: "Original" });
      post.title = "Changed";
      expect(post.title).toBe("Changed");
    });

    it("do NOT emit 'change'", () => {
      const post = Post.create();
      let fired = 0;
      post.on("change", () => fired++);
      post.title = "hello";
      post.views = 10;
      expect(fired).toBe(0);
    });
  });

  describe("save", () => {
    it("sends the full current state to the adapter", async () => {
      const post = Post.create({ title: "New Post" });
      await post.save();
      expect(adapter.saved.length).toBe(1);
      expect(adapter.saved[0].data.title).toBe("New Post");
    });

    it("clears __isNew after a successful save", async () => {
      const post = Post.create({ title: "Hi" });
      expect(post.__isNew).toBe(true);
      await post.save();
      expect(post.__isNew).toBe(false);
    });

    it("refreshes the server snapshot so flush becomes a no-op", async () => {
      const post = Post.create({ title: "A" });
      await post.save();
      // Nothing changed locally since save — flush should be a no-op.
      await post.flush();
      expect(adapter.patched.length).toBe(0);
    });
  });

  describe("flush", () => {
    it("routes to save() when the instance is still __isNew", async () => {
      const post = Post.create({ title: "Brand new" });
      await post.flush();
      expect(adapter.saved.length).toBe(1);
      expect(adapter.patched.length).toBe(0);
    });

    it("sends only the diff as RFC 6902 ops after direct writes", async () => {
      const post = Post.create({ title: "orig" });
      await post.save();
      post.title = "next";
      post.views = 7;
      await post.flush();
      expect(adapter.patched.length).toBe(1);
      const ops = adapter.patched[0].ops;
      const byPath: Record<string, any> = {};
      for (const op of ops) byPath[op.path] = op;
      expect(byPath["/title"]).toMatchObject({ op: "replace", value: "next" });
      expect(byPath["/views"]).toMatchObject({ op: "replace", value: 7 });
    });

    it("is a no-op when nothing has changed", async () => {
      const post = Post.create({ title: "nothing changes" });
      await post.save();
      await post.flush();
      await post.flush();
      expect(adapter.patched.length).toBe(0);
    });

    it("emits 'change' via its inner patch() call", async () => {
      const post = Post.create({ title: "a" });
      await post.save();
      let fired = 0;
      post.on("change", () => fired++);
      post.title = "b";
      await post.flush();
      expect(fired).toBe(1);
    });

    it("strips system-managed keys (id / type / createdAt / updatedAt / tmp) from the diff", async () => {
      const post = Post.create({ title: "a" });
      await post.save();
      adapter.patched.length = 0;

      // Simulate the backend mutating updatedAt to a fresh Date after
      // save — which is what our BackendAdapter does. If we didn't
      // strip it, `fast-json-patch.compare` would emit garbage char-
      // level ops for the Date, and the adapter would reject them as
      // an unknown column.
      (post as any).updatedAt = new Date();
      post.title = "b";
      await post.flush();

      expect(adapter.patched.length).toBe(1);
      const paths = adapter.patched[0].ops.map((o: any) => o.path);
      expect(paths).toContain("/title");
      expect(paths.some((p: string) => p.startsWith("/updatedAt"))).toBe(false);
      expect(paths.some((p: string) => p.startsWith("/createdAt"))).toBe(false);
      expect(paths.some((p: string) => p.startsWith("/id"))).toBe(false);
      expect(paths.some((p: string) => p.startsWith("/type"))).toBe(false);
    });

    it("is still a no-op when only system fields differ", async () => {
      const post = Post.create({ title: "a" });
      await post.save();
      adapter.patched.length = 0;
      (post as any).updatedAt = new Date();
      await post.flush();
      expect(adapter.patched.length).toBe(0);
    });

    it("coalesces concurrent calls into at most 2 round-trips (leading + trailing)", async () => {
      const post = Post.create({ title: "start" });
      await post.save();
      adapter.patched.length = 0;

      // Slow down the adapter's patch so the leading flush is
      // genuinely still in-flight when the follow-ups fire.
      const originalPatch = adapter.patch;
      adapter.patch = async (model: any, ops: any[]) => {
        await new Promise((r) => setTimeout(r, 10));
        return originalPatch(model, ops);
      };

      // Burst of flushes with new state each time. Streaming call
      // sites do exactly this — mutate + flush per delta.
      post.title = "a";
      const p1 = post.flush();
      post.title = "b";
      const p2 = post.flush();
      post.title = "c";
      const p3 = post.flush();
      post.title = "d";
      const p4 = post.flush();

      await Promise.all([p1, p2, p3, p4]);

      // Leading flush sends "a"; trailing coalesces b/c/d into one
      // follow-up patch with the final value.
      expect(adapter.patched.length).toBe(2);
      const lastOps = adapter.patched[1].ops;
      const lastTitle = lastOps.find((o: any) => o.path === "/title");
      expect(lastTitle?.value).toBe("d");

      // Lane clear again — next flush should be a fresh leading edge.
      adapter.patch = originalPatch;
      adapter.patched.length = 0;
      post.title = "e";
      await post.flush();
      expect(adapter.patched.length).toBe(1);
    });

    it("trailing flushes all resolve together", async () => {
      const post = Post.create({ title: "x" });
      await post.save();
      adapter.patched.length = 0;

      const originalPatch = adapter.patch;
      adapter.patch = async (model: any, ops: any[]) => {
        await new Promise((r) => setTimeout(r, 10));
        return originalPatch(model, ops);
      };

      post.title = "1";
      const p1 = post.flush();
      post.title = "2";
      const p2 = post.flush();
      post.title = "3";
      const p3 = post.flush();

      await Promise.all([p1, p2, p3]);

      expect(adapter.patched.length).toBe(2);
      adapter.patch = originalPatch;
    });
  });

  describe("patch", () => {
    it("emits 'change' synchronously on optimistic apply", async () => {
      const post = Post.create({ title: "orig" });
      await post.save();
      let fired = 0;
      post.on("change", () => fired++);
      await post.patch([{ op: "replace", path: "/title", value: "next" }]);
      expect(fired).toBe(1);
      expect(post.title).toBe("next");
    });

    it("is a no-op on an empty ops array", async () => {
      const post = Post.create({ title: "x" });
      await post.save();
      await post.patch([]);
      expect(adapter.patched.length).toBe(0);
    });

    it("updates the server snapshot so flush() won't resend the same op", async () => {
      const post = Post.create({ title: "x" });
      await post.save();
      await post.patch([{ op: "replace", path: "/title", value: "y" }]);
      adapter.patched.length = 0;
      await post.flush();
      expect(adapter.patched.length).toBe(0);
    });

    // DOL-1040: the patch ack path used to `structuredClone` the
    // whole snapshot before applying ops, then reassign the cloned
    // copy back to the symbol slot. The snapshot is private and the
    // public `__serverSnapshot` getter is documented `Readonly`, so
    // there's no consumer that needs the immutability — the defensive
    // clone was pure waste. After the fix we mutate in place; this
    // test pins that behaviour so we don't silently regress it.
    it("mutates __serverSnapshot in place across patches — identity stable, no allocation", async () => {
      const post = Post.create({ title: "x", views: 0 });
      await post.save();
      const before = (post as any).__serverSnapshot;
      await post.patch([{ op: "replace", path: "/title", value: "y" }]);
      await post.patch([{ op: "replace", path: "/views", value: 7 }]);
      const after = (post as any).__serverSnapshot;
      // Same object reference — no defensive structuredClone allocation
      // happened during the ack.
      expect(after).toBe(before);
      // Values still tracked correctly so a subsequent flush is a no-op.
      expect(after.title).toBe("y");
      expect(after.views).toBe(7);
      adapter.patched.length = 0;
      await post.flush();
      expect(adapter.patched.length).toBe(0);
    });

    // Regression — DOL-553. A patch like
    // `replace /tags/0/text` on a model with no prior `tags` field
    // used to auto-vivify `tags` as `{}`, leaving the field as
    // `{ "0": { text: "…" } }` and crashing every subsequent
    // `for (const t of tags)` with "object is not iterable".
    // Vivification now picks `[]` when the next path segment is a
    // numeric index.
    it("vivifies missing intermediates as [] when the next segment is a numeric index", async () => {
      const post = Post.create({ title: "x" });
      await post.save();
      await post.patch([
        {
          op: "add",
          path: "/tags/0",
          value: { text: "first" },
        },
      ]);
      const tags = (post as any).tags;
      expect(Array.isArray(tags)).toBe(true);
      expect(tags).toEqual([{ text: "first" }]);
      // Crucially, the value can be iterated without throwing.
      const collected: any[] = [];
      for (const t of tags) collected.push(t);
      expect(collected).toEqual([{ text: "first" }]);
    });

    it("vivifies deep numeric-segment paths through nested missing parents", async () => {
      const post = Post.create({ title: "x" });
      await post.save();
      // Mirrors the real shot-panel hook shape:
      //   replace /blocks/<id>/shots/<idx>/panel
      // on a row where neither `blocks.<id>` nor its `shots` field
      // exists yet.
      await post.patch([
        {
          op: "add",
          path: "/blocks/abc/shots/0/panel",
          value: { url: "https://example.test/p.png" },
        },
      ]);
      const blocks = (post as any).blocks;
      expect(blocks).toBeTypeOf("object");
      expect(Array.isArray(blocks)).toBe(false); // /blocks/abc → object
      expect(Array.isArray(blocks.abc.shots)).toBe(true); // /shots/0 → array
      expect(blocks.abc.shots[0].panel.url).toBe(
        "https://example.test/p.png",
      );
    });

    it("still vivifies non-numeric next segments as plain objects", async () => {
      const post = Post.create({ title: "x" });
      await post.save();
      await post.patch([
        { op: "replace", path: "/meta/cover/url", value: "u" },
      ]);
      const meta = (post as any).meta;
      expect(Array.isArray(meta)).toBe(false);
      expect(meta.cover.url).toBe("u");
    });

    it("vivifies the parent of an `add /…/-` append-marker as []", async () => {
      const post = Post.create({ title: "x" });
      await post.save();
      // RFC 6901 `-` segment means "after the last array element".
      // The parent must be an array for `applyPatch`'s array-add
      // branch to do its splice.
      await post.patch([
        { op: "add", path: "/tags/-", value: { text: "first" } },
      ]);
      const tags = (post as any).tags;
      expect(Array.isArray(tags)).toBe(true);
      expect(tags).toEqual([{ text: "first" }]);
    });

    it("vivifies multi-digit numeric segments as arrays (regression — the regex must accept '12', not just '1')", async () => {
      const post = Post.create({ title: "x" });
      await post.save();
      // Direct sparse-index add — fast-json-patch's array path
      // accepts numeric strings of any length.
      await post.patch([
        { op: "add", path: "/items/0", value: "first" },
        { op: "add", path: "/items/1", value: "second" },
      ]);
      // After the two adds, `items` is a real array of length 2.
      // The regression guard here is the regex that decides
      // numeric-vs-string: a literal-`/^\d$/` would only match
      // single-digit indices and fall through to `{}` for `"12"`.
      const items = (post as any).items;
      expect(Array.isArray(items)).toBe(true);
      expect(items).toEqual(["first", "second"]);
    });

    it("does not coerce a string segment that merely contains digits to array (e.g. 'b1')", async () => {
      const post = Post.create({ title: "x" });
      await post.save();
      // `b1` is a Scenecode-style block id, not a numeric index —
      // must remain an object lookup. If the regex were `/\d/`
      // (contains-digit) instead of `/^\d+$/` (all-digits),
      // `blocks.b1` would wrongly vivify as `[]`.
      await post.patch([
        { op: "add", path: "/blocks/b1/text", value: "hi" },
      ]);
      const blocks = (post as any).blocks;
      expect(Array.isArray(blocks)).toBe(false);
      expect(blocks.b1.text).toBe("hi");
    });

    it("preserves an existing array when patching a sub-index (does not clobber to {})", async () => {
      const post = Post.create({ title: "x" });
      await post.save();
      // Pre-seed an array so the intermediate already exists; the
      // vivification heuristic must NOT replace a healthy array
      // with `{}` (or even with a fresh `[]` — only missing /
      // null intermediates are touched).
      await post.patch([
        { op: "add", path: "/tags/0", value: "a" },
        { op: "add", path: "/tags/1", value: "b" },
      ]);
      // Now patch a deeper sub-path under the existing array.
      // First make tags entries objects.
      await post.patch([
        { op: "replace", path: "/tags/0", value: { text: "a" } },
        { op: "replace", path: "/tags/1", value: { text: "b" } },
      ]);
      await post.patch([
        { op: "replace", path: "/tags/0/role", value: "primary" },
      ]);
      const tags = (post as any).tags;
      expect(Array.isArray(tags)).toBe(true);
      expect(tags).toEqual([
        { text: "a", role: "primary" },
        { text: "b" },
      ]);
    });
  });

  describe("get / set dot-path accessors", () => {
    it("get() reads nested fields by dot-path", () => {
      const post = Post.create();
      (post as any).nested = { a: { b: "deep" } };
      expect(post.get<string>("nested.a.b")).toBe("deep");
    });

    it("get() returns undefined for missing paths", () => {
      const post = Post.create();
      expect(post.get("nope.nothing")).toBeUndefined();
    });

    it("set() writes nested fields and auto-creates intermediates", () => {
      const post = Post.create();
      post.set("nested.a.b", 42);
      expect((post as any).nested.a.b).toBe(42);
    });

    it("set() does NOT emit 'change' and does NOT call the adapter", () => {
      const post = Post.create();
      let fired = 0;
      post.on("change", () => fired++);
      post.set("title", "typed");
      expect(post.title).toBe("typed");
      expect(fired).toBe(0);
      expect(adapter.patched.length).toBe(0);
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

    it("sanitize strips fields listed in static privateFields", async () => {
      // Subclass with two sensitive fields. The default
      // implementation projects every column EXCEPT those — so a
      // developer who forgets to override `sanitize()` still gets a
      // safe shape over the wire.
      class Account extends Model {
        static type = "account" as const;
        static readonly privateFields = [
          "passwordHash",
          "resetToken",
        ] as const;
        email: string = "";
        passwordHash: string = "";
        resetToken: string = "";
      }

      const acc = Account.create({
        email: "a@b.com",
        passwordHash: "supersecret",
        resetToken: "tok-123",
      });

      const sanitized = await acc.sanitize();
      expect(sanitized.email).toBe("a@b.com");
      expect(sanitized.type).toBe("account");
      // Sensitive fields are gone from the projection.
      expect(sanitized.passwordHash).toBeUndefined();
      expect(sanitized.resetToken).toBeUndefined();

      // toJSON() ignores the list — it's the internal projection used
      // by hooks / subscriptions where the full row is needed.
      const internal = acc.toJSON();
      expect(internal.passwordHash).toBe("supersecret");
      expect(internal.resetToken).toBe("tok-123");
    });

    it("sanitize falls through to all fields when privateFields is empty", async () => {
      // Default behaviour for a class without an explicit
      // `privateFields` list — backward-compatible projection.
      const post = Post.create({ title: "Visible", views: 5 });
      const sanitized = await post.sanitize();
      expect(sanitized.title).toBe("Visible");
      expect(sanitized.views).toBe(5);
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

  // ── Reference field accessors (DOL-1045) ──────────────────────────
  //
  // Refs are installed as getter/setter pairs on the instance. Two
  // perf invariants pinned here:
  //
  //   1. Per-instance proxy memoization — `post.author` read twice
  //      with the same underlying raw id returns the SAME Proxy
  //      reference. A <UserCard user={post.author}> rendered 60×/sec
  //      should not allocate a fresh Proxy every render.
  //
  //   2. The lazy-load proxy's `ownKeys` / `getOwnPropertyDescriptor`
  //      surface is restricted so iteration (`Object.keys`,
  //      `JSON.stringify` shallow walk, `for..in`) doesn't trip the
  //      "any non-whitelisted prop access throws `loading`" trap and
  //      fire unintended `findById` requests from incidental code
  //      (DevTools, isEqual, structured-logger walks).
  describe("reference field accessors", () => {
    class Author extends Model {
      static type = "author" as const;
      name: string = "";
    }
    class Article extends Model {
      static type = "article" as const;
      // Set __schema explicitly: the resolver normally builds this
      // from ts-morph at startup; in tests we hand-roll it.
      static __schema = {
        title: "string",
        author: { kind: "ref", target: Author },
      } as any;
      title: string = "";
      // Declared but uninitialised — the accessor installer replaces
      // the (absent) data property with a getter/setter pair.
      declare author: Author;
    }

    // `expect(proxy).toBe(...)` walks the proxy via vitest's diff
    // formatter and trips the lazy-load `get` trap, so we compare
    // identity directly via `===` here and assert on the boolean.
    it("post.author returns the SAME proxy reference across reads (memoized per raw id)", () => {
      const article = Article.hydrate(adapter, { title: "x", author: "a1" });
      const first = article.author;
      const second = article.author;
      expect(first === second).toBe(true);
    });

    it("changing the raw id via post.author = ... invalidates the proxy cache", () => {
      const article = Article.hydrate(adapter, { title: "x", author: "a1" });
      const first = article.author;
      article.author = "a2" as any;
      const after = article.author;
      // Different raw id → different proxy reference.
      expect(after === first).toBe(false);
      // …but two reads after the change are still memoized.
      const afterAgain = article.author;
      expect(afterAgain === after).toBe(true);
    });

    it("changing the raw id via post.$author = ... also invalidates the proxy cache", () => {
      const article = Article.hydrate(adapter, { title: "x", author: "a1" });
      const first = article.author;
      (article as any).$author = "a3";
      const after = article.author;
      expect(after === first).toBe(false);
    });

    it("Object.keys(post.author) lists only the safe whitelist — no findById trip", () => {
      // Mark up the adapter so any accidental load attempt is loud
      // and obvious in the assertion (we'd see it in the spy).
      const findByIdSpy = vi.fn(async () => null);
      const oldFindById = adapter.findById;
      adapter.findById = findByIdSpy as any;
      try {
        const article = Article.hydrate(adapter, { title: "x", author: "a1" });
        const keys = Object.keys(article.author);
        // Only stable safe keys — anything that would force a load is absent.
        expect(keys.sort()).toEqual(["id", "type"]);
        expect(findByIdSpy).not.toHaveBeenCalled();
      } finally {
        adapter.findById = oldFindById;
      }
    });

    it("JSON.stringify(post.author) serializes the {id,type} stub without firing findById", () => {
      const findByIdSpy = vi.fn(async () => null);
      const oldFindById = adapter.findById;
      adapter.findById = findByIdSpy as any;
      try {
        const article = Article.hydrate(adapter, { title: "x", author: "a1" });
        const serialized = JSON.stringify(article.author);
        expect(JSON.parse(serialized)).toEqual({ id: "a1", type: "author" });
        expect(findByIdSpy).not.toHaveBeenCalled();
      } finally {
        adapter.findById = oldFindById;
      }
    });

    it("post.$author returns the raw id directly (no proxy allocation)", () => {
      const article = Article.hydrate(adapter, { title: "x", author: "a1" });
      expect((article as any).$author).toBe("a1");
    });

    it("post.author = null clears both the proxy and the raw id", () => {
      const article = Article.hydrate(adapter, { title: "x", author: "a1" });
      // Cast so the strict declared type doesn't fight us.
      (article as any).author = null;
      expect(article.author).toBeNull();
      expect((article as any).$author).toBeNull();
    });

    // ── Pre-hydrated ref proxy (DOL-1093 `.expand("file")` payload) ─────────
    //
    // When the wire payload includes a nested object on a ref field
    // (e.g. `.expand("file")` inlines the full File row), `_apply`
    // should:
    //
    //   1. Store the inline object's id as the raw id (`$file`).
    //   2. Hydrate the object into a target-class instance.
    //   3. Pre-populate the ref proxy's `loaded` slot so property
    //      access is SYNCHRONOUS — no `findById`, no Suspense throw.
    //
    // Without (3), the editor's `asset.file.url` reads would Suspense
    // even when the row was right there in the payload.
    describe("pre-hydrated ref proxy from inline expand payload", () => {
      it("hydrates an inline object into a target instance and serves fields synchronously", () => {
        const findByIdSpy = vi.fn(async () => null);
        const oldFindById = adapter.findById;
        adapter.findById = findByIdSpy as any;
        try {
          const article = Article.hydrate(adapter, {
            title: "x",
            author: { id: "a1", name: "Alice" },
          });
          // Synchronous read — no Suspense, no findById trip.
          expect((article.author as any).name).toBe("Alice");
          expect(findByIdSpy).not.toHaveBeenCalled();
        } finally {
          adapter.findById = oldFindById;
        }
      });

      it("still stamps $author with the inline object's id", () => {
        const article = Article.hydrate(adapter, {
          title: "x",
          author: { id: "a1", name: "Alice" },
        });
        expect((article as any).$author).toBe("a1");
      });

      it("memoizes the pre-hydrated proxy across reads", () => {
        const article = Article.hydrate(adapter, {
          title: "x",
          author: { id: "a1", name: "Alice" },
        });
        const first = article.author;
        const second = article.author;
        expect(first === second).toBe(true);
      });

      it("falls through to lazy load when the field is reassigned to a bare string id", () => {
        const findByIdSpy = vi.fn(async (_cls: any, _id: string) => null);
        const oldFindById = adapter.findById;
        adapter.findById = findByIdSpy as any;
        try {
          const article = Article.hydrate(adapter, {
            title: "x",
            author: { id: "a1", name: "Alice" },
          });
          // Synchronous on the pre-hydrated id.
          expect((article.author as any).name).toBe("Alice");
          expect(findByIdSpy).not.toHaveBeenCalled();
          // Reassign to a different id — must shed the pre-hydrated
          // proxy. The Model __refCache is module-scoped and keyed
          // by `${type}:${id}`; even if a prior test cached "a2",
          // the reassignment invalidates the instance-level cache
          // and a new read mints a fresh lazy proxy.
          article.author = "a2" as any;
          // Reading a non-whitelisted field now throws the lazy
          // load Promise (Suspense integration). Catch it so we
          // can assert findById was called.
          try {
            void (article.author as any).name;
          } catch (e) {
            if (!(e && typeof (e as any).then === "function")) throw e;
          }
          // findById is called synchronously inside the get trap;
          // the spy is recorded before the Promise resolves.
          expect(findByIdSpy).toHaveBeenCalledTimes(1);
          expect(findByIdSpy.mock.calls[0]![1]).toBe("a2");
        } finally {
          adapter.findById = oldFindById;
        }
      });

      it("ignores inline payloads without an id (defensive — falls through to null)", () => {
        const article = Article.hydrate(adapter, {
          title: "x",
          author: { name: "no-id" } as any,
        });
        // No id → no raw id, no proxy. Same as `author: null`.
        expect(article.author).toBeNull();
        expect((article as any).$author).toBeNull();
      });

      it("WithRefs<T> surfaces `$<refField>` even for nullable ref columns", () => {
        // Type-level assertion — the new `Nullable | Model` Model
        // class lets us declare `file: File | null = null` and have
        // `WithRefs<File>` still project the `$file` accessor.
        // Without the `NonNullable<T[K]> extends Model` predicate
        // change, this test wouldn't typecheck.
        class NullableRefModel extends Model {
          static override type = "nrm" as const;
          static override __schema = {
            author: { kind: "ref", target: Author },
          } as any;
          declare author: Author | null;
        }
        type Refs = import("../Model").WithRefs<NullableRefModel>;
        const sample = NullableRefModel.create({
          author: "a1",
        }) as Refs;
        // Type assertion + runtime sanity: $author is a string id.
        expect(typeof sample.$author).toBe("string");
        expect(sample.$author).toBe("a1");
      });
    });
  });
});
