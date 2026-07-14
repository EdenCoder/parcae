import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Model,
  SYM_SERVER_MERGE,
  SYM_SERVER_PATCH,
  SYM_VERSION,
  generateId,
} from "../Model";
import type { ModelOperationsEvent, Ref, WithRefs } from "../Model";
import type { ModelAdapter, QueryChain } from "../adapters/types";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
    save: async (model: any, data: Record<string, any>) => {
      adapter.saved.push({ model, data: structuredClone(data) });
      return structuredClone(data);
    },
    remove: async (model: any) => {
      adapter.removed.push(model);
    },
    findById: async () => null,
    query: () => ({}) as QueryChain<any>,
    patch: async (
      model: any,
      ops: any[],
      _data: Record<string, any>,
    ) => {
      adapter.patched.push({ model, ops: structuredClone(ops) });
      return structuredClone(_data);
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Model", () => {
  const adapter = createMockAdapter();

  beforeEach(() => {
    adapter.saved.length = 0;
    adapter.removed.length = 0;
    adapter.patched.length = 0;
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

    it("keeps edits made during save dirty for the next flush", async () => {
      const originalSave = adapter.save;
      const gate = deferred<void>();
      adapter.save = async (model, data) => {
        adapter.saved.push({ model, data: structuredClone(data) });
        await gate.promise;
        return structuredClone(data);
      };

      try {
        const post = Post.create({ title: "sent" });
        const saving = post.save();
        post.title = "edited while saving";
        gate.resolve();
        await saving;

        expect(post.__serverSnapshot.title).toBe("sent");
        expect(post.title).toBe("edited while saving");

        await post.flush();
        expect(adapter.patched).toHaveLength(1);
        expect(adapter.patched[0].ops).toContainEqual({
          op: "replace",
          path: "/title",
          value: "edited while saving",
        });
      } finally {
        adapter.save = originalSave;
      }
    });

    it("advances a void save snapshot only to the submitted payload", async () => {
      const originalSave = adapter.save;
      adapter.save = async (model, data) => {
        adapter.saved.push({ model, data: structuredClone(data) });
        model.title = "after hook";
      };

      try {
        const post = Post.create({ title: "before hook" });
        await post.save();

        expect(post.title).toBe("after hook");
        expect(post.__serverSnapshot.title).toBe("before hook");
        await post.flush();
        expect(adapter.patched).toHaveLength(1);
        expect(adapter.patched[0].ops).toContainEqual({
          op: "replace",
          path: "/title",
          value: "after hook",
        });
      } finally {
        adapter.save = originalSave;
      }
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
      adapter.patch = async (
        model: any,
        ops: any[],
        data: Record<string, any>,
      ) => {
        await new Promise((r) => setTimeout(r, 10));
        return originalPatch(model, ops, data);
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
      adapter.patch = async (
        model: any,
        ops: any[],
        data: Record<string, any>,
      ) => {
        await new Promise((r) => setTimeout(r, 10));
        return originalPatch(model, ops, data);
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

    it("does not duplicate a create across concurrent new-model flushes", async () => {
      const originalSave = adapter.save;
      const gate = deferred<void>();
      adapter.save = async (model, data) => {
        adapter.saved.push({ model, data: structuredClone(data) });
        await gate.promise;
        return structuredClone(data);
      };

      try {
        const post = Post.create({ title: "first" });
        const first = post.flush();
        post.title = "second";
        const second = post.flush();

        expect(adapter.saved).toHaveLength(1);
        gate.resolve();
        await Promise.all([first, second]);

        expect(adapter.saved).toHaveLength(1);
        expect(adapter.patched).toHaveLength(1);
        expect(adapter.patched[0].ops).toContainEqual({
          op: "replace",
          path: "/title",
          value: "second",
        });
      } finally {
        adapter.save = originalSave;
      }
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
      await post.patch([
        {
          op: "add",
          path: "/items/12/name",
          value: "thirteenth",
        },
      ]);
      const items = (post as any).items;
      expect(Array.isArray(items)).toBe(true);
      expect(items).toHaveLength(13);
      expect(items[0]).toBeUndefined();
      expect(items[12]).toEqual({ name: "thirteenth" });
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

    it("deletes a top-level property locally", async () => {
      const post = Post.create({ obsolete: "remove me" });
      await post.save();

      await post.patch([{ op: "remove", path: "/obsolete" }]);

      expect(Object.prototype.hasOwnProperty.call(post, "obsolete")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(post.__data, "obsolete")).toBe(
        false,
      );
    });

    it("decodes RFC 6901 escaped segments when copying patched keys locally", async () => {
      const post = Post.create({
        "a/b": { "til~de": "before" },
      });
      await post.save();

      await post.patch([
        {
          op: "replace",
          path: "/a~1b/til~0de",
          value: "after",
        },
      ]);

      expect((post as any)["a/b"]["til~de"]).toBe("after");
    });

    it("keeps overlapping patch paths pending until every write settles", async () => {
      const originalPatch = adapter.patch;
      const firstGate = deferred<void>();
      const secondGate = deferred<void>();
      let call = 0;
      adapter.patch = async (model, ops, data) => {
        adapter.patched.push({
          model,
          ops: structuredClone(ops),
          data: structuredClone(data),
        });
        await (call++ === 0 ? firstGate.promise : secondGate.promise);
      };

      try {
        const post = Post.create({ title: "start" });
        await post.save();

        const first = post.patch([
          { op: "replace", path: "/title", value: "first" },
        ]);
        const second = post.patch([
          { op: "replace", path: "/title", value: "second" },
        ]);

        expect(post.__patchingPaths.has("/title")).toBe(true);
        firstGate.resolve();
        await first;
        expect(post.__patchingPaths.has("/title")).toBe(true);

        secondGate.resolve();
        await second;
        expect(post.__patchingPaths.has("/title")).toBe(false);
      } finally {
        adapter.patch = originalPatch;
      }
    });

    it("three-way merges authoritative nested siblings with edits made during the write", async () => {
      const originalPatch = adapter.patch;
      const response = deferred<Record<string, any>>();
      adapter.patch = async () => response.promise;

      try {
        const post = Post.hydrate(adapter, {
          id: "p1",
          profile: { name: "before", theme: "light", rank: 1 },
        });
        const writing = post.patch([
          { op: "replace", path: "/profile/name", value: "client" },
        ]);
        (post as any).profile.theme = "local while writing";

        response.resolve({
          ...post.__data,
          profile: {
            name: "SERVER CANONICAL",
            theme: "light",
            rank: 2,
          },
        });
        await writing;

        expect((post as any).profile).toEqual({
          name: "SERVER CANONICAL",
          theme: "local while writing",
          rank: 2,
        });
        expect(post.__serverSnapshot.profile).toEqual({
          name: "SERVER CANONICAL",
          theme: "light",
          rank: 2,
        });

        adapter.patch = originalPatch;
        adapter.patched.length = 0;
        await post.flush();
        expect(adapter.patched[0].ops).toContainEqual({
          op: "replace",
          path: "/profile/theme",
          value: "local while writing",
        });
      } finally {
        adapter.patch = originalPatch;
      }
    });

    it("does not snapshot a later queued patch when a void patch completes", async () => {
      const originalPatch = adapter.patch;
      const firstGate = deferred<void>();
      const secondGate = deferred<void>();
      let call = 0;
      adapter.patch = async () => {
        if (call++ === 0) {
          await firstGate.promise;
          return;
        }
        await secondGate.promise;
        throw new Error("second patch failed");
      };

      try {
        const post = Post.hydrate(adapter, {
          id: "p1",
          profile: { name: "before", theme: "light" },
        });
        const first = post.patch([
          { op: "replace", path: "/profile/name", value: "first" },
        ]);
        const second = post.patch([
          { op: "replace", path: "/profile/theme", value: "second" },
        ]);

        firstGate.resolve();
        await first;
        secondGate.resolve();
        await expect(second).rejects.toThrow("second patch failed");

        expect(post.__serverSnapshot.profile).toEqual({
          name: "first",
          theme: "light",
        });
        expect((post as any).profile.theme).toBe("second");

        adapter.patch = originalPatch;
        adapter.patched.length = 0;
        await post.flush();
        expect(adapter.patched[0].ops).toContainEqual({
          op: "replace",
          path: "/profile/theme",
          value: "second",
        });
      } finally {
        adapter.patch = originalPatch;
      }
    });
  });

  describe("operations", () => {
    it("stage applies locally without calling the adapter or changing write state", () => {
      const post = Post.hydrate(adapter, { id: "p1", title: "before" });

      post.stage([{ op: "replace", path: "/title", value: "after" }]);

      expect(post.title).toBe("after");
      expect(adapter.patched).toHaveLength(0);
      expect(adapter.saved).toHaveLength(0);
      expect(post.__savingCount).toBe(0);
      expect(post.__patchingPaths.size).toBe(0);
    });

    it("emits normalized cloned local ops with the current revision", () => {
      const post = Post.hydrate(adapter, {
        id: "p1",
        meta: { nested: true },
      });
      const events: ModelOperationsEvent[] = [];
      post.on("operations", (event: ModelOperationsEvent) => events.push(event));

      post.stage([
        { op: "remove", path: "/meta" },
        { op: "remove", path: "/meta/nested" },
        { op: "remove", path: "/meta" },
      ]);

      expect(events).toEqual([
        {
          ops: [{ op: "remove", path: "/meta" }],
          source: "local",
          revision: 1,
        },
      ]);
      expect(events[0]!.revision).toBe(post[SYM_VERSION]);
    });

    it("patch applies and emits once while adapter ops remain listener-safe", async () => {
      const post = Post.hydrate(adapter, { id: "p1", tags: [] });
      const events: ModelOperationsEvent[] = [];
      post.on("operations", (event: ModelOperationsEvent) => {
        events.push(event);
        (event.ops[0] as any).value = "mutated by listener";
      });

      await post.patch([{ op: "add", path: "/tags/-", value: "first" }]);

      expect((post as any).tags).toEqual(["first"]);
      expect(events).toHaveLength(1);
      expect(adapter.patched).toHaveLength(1);
      expect(adapter.patched[0].ops).toEqual([
        { op: "add", path: "/tags/-", value: "first" },
      ]);
    });

    it("emits effective remote ops with the post-merge revision", () => {
      const post = Post.hydrate(adapter, {
        id: "p1",
        profile: { name: "before", rank: 1 },
      });
      const events: ModelOperationsEvent[] = [];
      post.on("operations", (event: ModelOperationsEvent) => events.push(event));

      post[SYM_SERVER_MERGE]({
        ...post.__serverSnapshot,
        profile: { name: "after", rank: 1 },
      });

      expect(events).toEqual([
        {
          ops: [{ op: "replace", path: "/profile/name", value: "after" }],
          source: "remote",
          revision: 1,
        },
      ]);
    });

    it("does not emit remote ops when local replay hides a same-path change", () => {
      const post = Post.hydrate(adapter, { id: "p1", title: "before" });
      const events: ModelOperationsEvent[] = [];
      post.on("operations", (event: ModelOperationsEvent) => events.push(event));
      post.stage([{ op: "replace", path: "/title", value: "local" }]);
      events.length = 0;

      post[SYM_SERVER_MERGE]({
        ...post.__serverSnapshot,
        title: "remote",
      });

      expect(post.title).toBe("local");
      expect(events).toHaveLength(0);
    });

    it("preserves staged local edits while emitting remote sibling changes", () => {
      const post = Post.hydrate(adapter, {
        id: "p1",
        profile: { name: "before", rank: 1 },
      });
      const events: ModelOperationsEvent[] = [];
      post.on("operations", (event: ModelOperationsEvent) => events.push(event));
      post.stage([
        { op: "replace", path: "/profile/name", value: "local" },
      ]);
      events.length = 0;

      post[SYM_SERVER_PATCH]([
        { op: "replace", path: "/profile/rank", value: 2 },
      ]);

      expect((post as any).profile).toEqual({ name: "local", rank: 2 });
      expect(events).toEqual([
        {
          ops: [{ op: "replace", path: "/profile/rank", value: 2 }],
          source: "remote",
          revision: 2,
        },
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

    it("refuses to silently replace an application adapter", () => {
      expect(() => Model.use(createMockAdapter())).toThrow(
        /Adapter already set/,
      );
      expect(Model.getAdapter()).toBe(adapter);
    });

    it("binds independent static model contexts to separate adapters", async () => {
      const firstAdapter = createMockAdapter();
      const secondAdapter = createMockAdapter();
      firstAdapter.findById = vi.fn(async () => null);
      secondAdapter.findById = vi.fn(async () => null);
      const FirstPost = Post.bind(firstAdapter);
      const SecondPost = Post.bind(secondAdapter);

      await FirstPost.create({ title: "first" }).save();
      await SecondPost.create({ title: "second" }).save();
      await FirstPost.findById("first-id");
      await SecondPost.findById("second-id");

      expect(firstAdapter.saved.map((entry) => entry.data.title)).toEqual([
        "first",
      ]);
      expect(secondAdapter.saved.map((entry) => entry.data.title)).toEqual([
        "second",
      ]);
      expect(FirstPost.where({ published: true }).__adapter).toBe(firstAdapter);
      expect(SecondPost.where({ published: true }).__adapter).toBe(
        secondAdapter,
      );
      expect(firstAdapter.findById).toHaveBeenCalledWith(
        FirstPost,
        "first-id",
      );
      expect(secondAdapter.findById).toHaveBeenCalledWith(
        SecondPost,
        "second-id",
      );
    });

    it("binds after a constructor has its own adapter", () => {
      class OwnPost extends Model {
        static type = "own-post" as const;
        static path = "/v1/own-posts";
      }
      const ownAdapter = createMockAdapter();
      const boundAdapter = createMockAdapter();
      OwnPost.use(ownAdapter);

      const BoundPost = OwnPost.bind(boundAdapter);
      const post = BoundPost.create();

      expect(OwnPost.getAdapter()).toBe(ownAdapter);
      expect(BoundPost.getAdapter()).toBe(boundAdapter);
      expect(BoundPost.type).toBe(OwnPost.type);
      expect(BoundPost.path).toBe(OwnPost.path);
      expect(post.constructor).toBe(BoundPost);
      expect(post).toBeInstanceOf(OwnPost);
    });

  });

  describe("lazy query chains", () => {
    it("should build without adapter", () => {
      // These should NOT throw — they build lazy chains
      const chain = Post.where({ published: true });
      expect(chain.__steps).toBeDefined();
      expect(chain.__modelType).toBe("post");

      const chain2 = Post.select("id", "title").orderBy("createdAt", "desc");
      expect(chain2.__steps?.length).toBe(2);
    });

    it("serializes callback query steps for stable cache keys", () => {
      const first = Post.where((query: any) => {
        query.where("id", "thedaywalker").orWhere("username", "thedaywalker");
      });
      const second = Post.where((query: any) => {
        query.where("id", "happytruth").orWhere("username", "happytruth");
      });

      expect(first.__steps).toEqual([
        {
          method: "where",
          args: [
            {
              __nested: [
                { method: "where", args: ["id", "thedaywalker"] },
                { method: "orWhere", args: ["username", "thedaywalker"] },
              ],
            },
          ],
        },
      ]);
      expect(JSON.stringify(first.__steps)).not.toBe(
        JSON.stringify(second.__steps),
      );
    });

    it("resolves sum as a scalar terminal", async () => {
      const query: any = {
        where: vi.fn(() => query),
        sum: vi.fn(async () => 42),
      };
      adapter.query = vi.fn(() => query);

      await expect(Post.where({ published: true }).sum("views")).resolves.toBe(42);

      expect(query.where).toHaveBeenCalledWith({ published: true });
      expect(query.sum).toHaveBeenCalledWith("views");
    });
  });

  // ── Reference field accessors (DOL-1045) ──────────────────────────
  //
  // A ref field keeps either its raw id or an explicitly expanded object.
  // `$field` always projects the raw id and never triggers a fetch.
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
      declare author: Ref<Author>;
    }

    it("keeps field identity stable across reads", () => {
      const article = Article.hydrate(adapter, { title: "x", author: "a1" });
      const first = article.author;
      const second = article.author;
      expect(first === second).toBe(true);
    });

    it("changing the field updates the raw accessor", () => {
      const article = Article.hydrate(adapter, { title: "x", author: "a1" });
      const first = article.author;
      article.author = "a2" as any;
      const after = article.author;
      expect(after === first).toBe(false);
      const afterAgain = article.author;
      expect(afterAgain === after).toBe(true);
      expect(article.$author).toBe("a2");
    });

    it("changing the raw accessor updates the field", () => {
      const article = Article.hydrate(adapter, { title: "x", author: "a1" });
      const first = article.author;
      (article as any).$author = "a3";
      const after = article.author;
      expect(after === first).toBe(false);
      expect(after).toBe("a3");
    });

    it("keeps an unexpanded ref as its raw id without loading", () => {
      const findByIdSpy = vi.fn(async () => null);
      const oldFindById = adapter.findById;
      adapter.findById = findByIdSpy as any;
      try {
        const article = Article.hydrate(adapter, { title: "x", author: "a1" });
        expect(article.author).toBe("a1");
        expect(article.$author).toBe("a1");
        expect(findByIdSpy).not.toHaveBeenCalled();
      } finally {
        adapter.findById = oldFindById;
      }
    });

    it("serializes an unexpanded ref as its raw id", () => {
      const findByIdSpy = vi.fn(async () => null);
      const oldFindById = adapter.findById;
      adapter.findById = findByIdSpy as any;
      try {
        const article = Article.hydrate(adapter, { title: "x", author: "a1" });
        const serialized = JSON.stringify(article.author);
        expect(JSON.parse(serialized)).toBe("a1");
        expect(findByIdSpy).not.toHaveBeenCalled();
      } finally {
        adapter.findById = oldFindById;
      }
    });

    it("includes raw ref companions in sanitized wire data", async () => {
      const article = Article.hydrate(adapter, {
        id: "article-1",
        title: "x",
        author: "a1",
      });

      expect(article.sanitize()).toMatchObject({
        author: "a1",
        $author: "a1",
      });
    });

    it("post.$author returns the raw id directly", () => {
      const article = Article.hydrate(adapter, { title: "x", author: "a1" });
      expect((article as any).$author).toBe("a1");
    });

    it("post.author = null clears both the field and raw id", () => {
      const article = Article.hydrate(adapter, { title: "x", author: "a1" });
      // Cast so the strict declared type doesn't fight us.
      (article as any).author = null;
      expect(article.author).toBeNull();
      expect((article as any).$author).toBeNull();
    });

    it("does not auto-load raw refs on property access", () => {
      const refAdapter = createMockAdapter();
      refAdapter.findById = vi.fn(async () => null);
      const article = Article.hydrate(refAdapter, { author: "a1" });

      expect((article.author as any).name).toBeUndefined();
      expect(article.$author).toBe("a1");
      expect(refAdapter.findById).not.toHaveBeenCalled();
    });

    it("Ref<T> remains raw-or-expanded across query chains", () => {
      const chain = Article.where({ title: "x" }).expand("author");
      type Row = Awaited<ReturnType<typeof chain.find>>[number];
      const includesRawId: string extends Row["author"] ? true : false = true;
      type ExpandedAuthor = Exclude<Row["author"], string>;
      const exposesData: "name" extends keyof ExpandedAuthor ? true : false = true;
      const exposesModelMethods: "save" extends keyof ExpandedAuthor ? true : false = false;
      const readName = (row: Row): string | undefined =>
        typeof row.author === "string" ? undefined : row.author.name;

      expect(includesRawId).toBe(true);
      expect(exposesData).toBe(true);
      expect(exposesModelMethods).toBe(false);
      expect(readName).toBeTypeOf("function");
    });

    // ── Inline `.expand("file")` payload ───────────────────────────
    //
    // When the wire payload includes a nested object on a ref field
    // (e.g. `.expand("file")` inlines the full File row), `_apply`
    // should:
    //
    //   1. Store the inline object's id as the raw id (`$file`).
    //   2. Keep the inline object available synchronously.
    describe("inline expanded ref payload", () => {
      it("keeps an inline object and serves fields synchronously", () => {
        const findByIdSpy = vi.fn(async () => null);
        const oldFindById = adapter.findById;
        adapter.findById = findByIdSpy as any;
        try {
          const article = Article.hydrate(adapter, {
            title: "x",
            author: { id: "a1", name: "Alice" },
          });
          // Synchronous read with no findById trip.
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

      it("keeps the inline object's identity across reads", () => {
        const article = Article.hydrate(adapter, {
          title: "x",
          author: { id: "a1", name: "Alice" },
        });
        const first = article.author;
        const second = article.author;
        expect(first === second).toBe(true);
      });

      it("keeps a reassigned bare id raw and synchronized", () => {
        const findByIdSpy = vi.fn(async (_cls: any, _id: string) => null);
        const oldFindById = adapter.findById;
        adapter.findById = findByIdSpy as any;
        try {
          const article = Article.hydrate(adapter, {
            title: "x",
            author: { id: "a1", name: "Alice" },
          });
          expect((article.author as any).name).toBe("Alice");
          expect(findByIdSpy).not.toHaveBeenCalled();
          article.author = "a2" as any;
          expect(article.author).toBe("a2");
          expect(article.$author).toBe("a2");
          expect(findByIdSpy).not.toHaveBeenCalled();
        } finally {
          adapter.findById = oldFindById;
        }
      });

      it("ignores inline payloads without an id (defensive — falls through to null)", () => {
        const article = Article.hydrate(adapter, {
          title: "x",
          author: { name: "no-id" } as any,
        });
        // No id means no usable ref. Same as `author: null`.
        expect(article.author).toBeNull();
        expect((article as any).$author).toBeNull();
      });

      it("WithRefs<T> surfaces `$<refField>` even for nullable ref columns", () => {
        // Type-level assertion — the new `Nullable | Model` Model
        // class lets us declare `file: Ref<File> | null = null` and have
        // `WithRefs<File>` still project the `$file` accessor.
        // Without the `NonNullable<T[K]> extends Model` predicate
        // change, this test wouldn't typecheck.
        class NullableRefModel extends Model {
          static override type = "nrm" as const;
          static override __schema = {
            author: { kind: "ref", target: Author },
          } as any;
          declare author: Ref<Author> | null;
        }
        const sample: WithRefs<NullableRefModel> = NullableRefModel.create({
          author: "a1",
        });
        const rawId: string | null = sample.$author;
        expect(typeof sample.$author).toBe("string");
        expect(rawId).toBe("a1");
      });

      it("WithRefs<T> does not infer refs from any fields", () => {
        class JsonModel extends Model {
          static override type = "json-model" as const;
          payload: any = {};
        }
        type HasRawPayload = "$payload" extends keyof WithRefs<JsonModel>
          ? true
          : false;
        const hasRawPayload: HasRawPayload = false;
        expect(hasRawPayload).toBe(false);
      });

      it("WithRefs<T> does not infer refs from mixed structural JSON fields", () => {
        class JsonModel extends Model {
          static override type = "json-model" as const;
          payload: { id: string; name?: string } | string | { value: string } = {
            value: "x",
          };
        }
        type HasRawPayload = "$payload" extends keyof WithRefs<JsonModel>
          ? true
          : false;
        const hasRawPayload: HasRawPayload = false;
        expect(hasRawPayload).toBe(false);
      });

      it("WithRefs<T> does not hide legacy bare Model declarations", () => {
        class LegacyArticle extends Model {
          static override type = "legacy-article" as const;
          declare author: Author;
        }
        type HasRawAuthor = "$author" extends keyof WithRefs<LegacyArticle>
          ? true
          : false;
        const hasRawAuthor: HasRawAuthor = false;
        expect(hasRawAuthor).toBe(false);
      });
    });

    describe("schema-free client refs", () => {
      class SchemaFreeArticle extends Model {
        static override type = "schema-free-article" as const;
        author: Ref<Author> | null = null;
        payload: { id: string; name: string } = { id: "", name: "" };
      }

      it("retains wire-declared refs and serializes their raw ids", () => {
        const article = SchemaFreeArticle.hydrate(adapter, {
          author: { id: "a1", name: "Alice" },
          $author: "a1",
        });

        expect(article.$author).toBe("a1");
        expect(article.__data.author).toBe("a1");
      });

      it("keeps the raw id when an expansion target is unavailable", () => {
        const article = SchemaFreeArticle.hydrate(adapter, {
          author: null,
          $author: "missing",
        });

        expect(article.author).toBe("missing");
        expect(article.$author).toBe("missing");
      });

      it("does not treat ordinary JSON objects with ids as refs", () => {
        const article = SchemaFreeArticle.hydrate(adapter, {
          payload: { id: "payload-1", name: "before" },
        });
        article[SYM_SERVER_PATCH]([
          { op: "replace", path: "/payload/name", value: "after" },
        ]);

        expect(article.payload.name).toBe("after");
        expect(article.__serverSnapshot.payload.name).toBe("after");
      });

      it("serializes an assigned Model as a raw id", () => {
        const article = SchemaFreeArticle.hydrate(adapter, {
          author: "a1",
          $author: "a1",
        });
        article.author = Author.hydrate(adapter, {
          id: "a2",
          name: "Alice",
        });

        expect(article.$author).toBe("a2");
        expect(article.__data.author).toBe("a2");
      });

      it("serializes an assigned Model on a fresh schema-free ref", () => {
        const article = SchemaFreeArticle.create();
        article.author = Author.hydrate(adapter, {
          id: "a2",
          name: "Alice",
        });

        expect(article.$author).toBe("a2");
        expect(article.__data.author).toBe("a2");
      });

      it("carries expanded-ref identity into a fresh schema-free model", () => {
        const source = SchemaFreeArticle.hydrate(adapter, {
          author: { id: "a1", name: "Alice" },
          $author: "a1",
        });
        const article = SchemaFreeArticle.create();
        article.author = source.author;

        expect(article.$author).toBe("a1");
        expect(article.__data.author).toBe("a1");
      });

    });

    // ── SYM_SERVER_MERGE keeps refs stable without hiding updates ──
    //
    // Subscriptions ship `__data`-style server snapshots: ref columns
    // serialize as raw id strings (`{ file: "f1" }`), NOT as inlined
    // objects. When the merge writes the incoming string into the
    // ref field directly, replacing an expanded object with the id would
    // make linked data disappear after every unrelated patch.
    //
    // Raw snapshots with the same id preserve an existing expansion.
    // Fresh expanded data replaces plain projections so identity-based
    // subscribers observe changes and removed fields do not stay stale.
    describe("SYM_SERVER_MERGE — ref-field stability (DOL-1097)", () => {
      it("preserves the expanded object when serverData carries the same raw id", () => {
        const findByIdSpy = vi.fn(async () => null);
        const oldFindById = adapter.findById;
        adapter.findById = findByIdSpy as any;
        try {
          const article = Article.hydrate(adapter, {
            title: "x",
            author: { id: "a1", name: "Alice" },
          });
          // Capture the expanded object and confirm synchronous access.
          const before = article.author;
          expect((before as any).name).toBe("Alice");
          expect(findByIdSpy).not.toHaveBeenCalled();

          // Server emits an unrelated `status` flip; the patch
          // pipeline rebuilds the snapshot from `__data` which
          // serializes `author` as the raw id "a1". Apply via
          // SYM_SERVER_MERGE — the same shape `useQuery.applyOps`
          // uses for every subscription patch.
          article[SYM_SERVER_MERGE]({
            title: "x",
            author: "a1",
            status: "ready",
          } as any);

          const after = article.author;
          // Same object reference. Expanded data remains available.
          expect(after === before).toBe(true);
          expect((after as any).name).toBe("Alice");
          expect(findByIdSpy).not.toHaveBeenCalled();
        } finally {
          adapter.findById = oldFindById;
        }
      });

      it("replaces the expanded value when serverData carries a different raw id", () => {
        const article = Article.hydrate(adapter, {
          title: "x",
          author: "a1",
        });
        const before = article.author;
        article[SYM_SERVER_MERGE]({
          title: "x",
          author: "a2",
        } as any);
        const after = article.author;
        // Different raw id replaces the old expanded value.
        expect(after === before).toBe(false);
        expect((article as any).$author).toBe("a2");
      });

      it("does not touch the ref accessor when serverData omits the ref field", () => {
        // A patch that only changes `title` doesn't include the
        // `author` key — the loop body never sees it, so the expanded value
        // is untouched regardless of this fix.
        const article = Article.hydrate(adapter, {
          title: "x",
          author: { id: "a1", name: "Alice" },
        });
        const before = article.author;
        article[SYM_SERVER_MERGE]({ title: "y" } as any);
        expect(article.title).toBe("y");
        expect(article.author === before).toBe(true);
      });

      it("keeps an omitted ref in the flush baseline", async () => {
        const article = Article.hydrate(adapter, {
          id: "article-1",
          title: "x",
          author: { id: "a1", name: "Alice" },
        });

        article[SYM_SERVER_MERGE]({ title: "y" } as any);
        await article.flush();

        expect(adapter.patched).toHaveLength(0);
      });

      it("advances an omitted ref baseline after a write acknowledgement", async () => {
        const article = Article.hydrate(adapter, {
          id: "article-1",
          title: "x",
          author: "a1",
        });
        article.author = "a2";
        const expected = structuredClone(article.__data);

        article[SYM_SERVER_MERGE]({ id: "article-1", title: "x" }, expected);

        expect(article.author).toBe("a2");
        expect(article.__serverSnapshot.author).toBe("a2");
        await article.flush();
        expect(adapter.patched).toHaveLength(0);
      });

      it("tracks the new raw id after an expanded subscription ref swap", async () => {
        const article = Article.hydrate(adapter, {
          id: "article-1",
          author: { id: "a1", name: "Alice" },
          $author: "a1",
        });

        article[SYM_SERVER_PATCH]([
          { op: "replace", path: "/author/id", value: "a2" },
          { op: "replace", path: "/author/name", value: "Bob" },
          { op: "replace", path: "/$author", value: "a2" },
        ]);

        expect(article.$author).toBe("a2");
        expect(article.__serverSnapshot.author).toBe("a2");
        await article.flush();
        expect(adapter.patched).toHaveLength(0);
      });

      it("keeps the raw id when an expanded target becomes unavailable", async () => {
        const article = Article.hydrate(adapter, {
          id: "article-1",
          author: { id: "a1", name: "Alice" },
          $author: "a1",
        });

        article[SYM_SERVER_PATCH]([
          { op: "replace", path: "/author", value: null },
        ]);

        expect(article.author).toBe("a1");
        expect(article.$author).toBe("a1");
        expect(article.__serverSnapshot.author).toBe("a1");
        await article.flush();
        expect(adapter.patched).toHaveLength(0);
      });

      it("keeps the raw id when a collapsed expansion becomes unavailable", () => {
        const article = Article.hydrate(adapter, {
          id: "article-1",
          author: { id: "a1", name: "Alice" },
          $author: "a1",
        });
        article.author = "a1";

        article[SYM_SERVER_PATCH]([
          { op: "replace", path: "/author", value: null },
        ]);

        expect(article.author).toBe("a1");
        expect(article.$author).toBe("a1");
      });

      it("clears a ref when the expanded raw id is also cleared", () => {
        const article = Article.hydrate(adapter, {
          id: "article-1",
          author: { id: "a1", name: "Alice" },
          $author: "a1",
        });

        article[SYM_SERVER_PATCH]([
          { op: "replace", path: "/author", value: null },
          { op: "replace", path: "/$author", value: null },
        ]);

        expect(article.author).toBeNull();
        expect(article.$author).toBeNull();
      });

      it("clears a ref explicitly removed from the wire projection", async () => {
        const article = Article.hydrate(adapter, {
          id: "article-1",
          author: { id: "a1", name: "Alice" },
          $author: "a1",
        });

        article[SYM_SERVER_PATCH]([
          { op: "remove", path: "/author" },
          { op: "remove", path: "/$author" },
        ]);

        expect(article.author).toBeNull();
        expect(article.$author).toBeNull();
        expect(article.__serverSnapshot.author).toBeNull();
        await article.flush();
        expect(adapter.patched).toHaveLength(0);
      });

      it("preserves the raw id when only the expanded field is removed", async () => {
        const article = Article.hydrate(adapter, {
          id: "article-1",
          author: { id: "a1", name: "Alice" },
          $author: "a1",
        });

        article[SYM_SERVER_PATCH]([
          { op: "remove", path: "/author" },
        ]);

        expect(article.author).toBe("a1");
        expect(article.$author).toBe("a1");
        expect(article.__serverSnapshot.author).toBe("a1");
        await article.flush();
        expect(adapter.patched).toHaveLength(0);
      });

      it("replaces a plain expanded ref after a nested patch", () => {
        const article = Article.hydrate(adapter, {
          id: "article-1",
          author: { id: "a1", name: "Alice" },
        });
        const before = article.author;

        article[SYM_SERVER_PATCH]([
          { op: "replace", path: "/author/name", value: "Alicia" },
        ]);

        expect((article as any).$author).toBe("a1");
        expect(article.author === before).toBe(false);
        expect((article.author as any).name).toBe("Alicia");
      });

      it("emits nested expanded-ref subscription operations", () => {
        const article = Article.hydrate(adapter, {
          id: "article-1",
          author: { id: "a1", name: "Alice" },
        });
        const events: ModelOperationsEvent[] = [];
        article.on("operations", (event: ModelOperationsEvent) => events.push(event));

        article[SYM_SERVER_PATCH]([
          { op: "replace", path: "/author/name", value: "Alicia" },
        ]);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          source: "remote",
          ops: [{ op: "replace", path: "/author/name", value: "Alicia" }],
        });
      });

      it("omits ineffective nested expanded-ref operations", () => {
        const article = Article.hydrate(adapter, {
          id: "article-1",
          author: { id: "a1", name: "Alice" },
        });
        const events: ModelOperationsEvent[] = [];
        article.on("operations", (event: ModelOperationsEvent) => events.push(event));

        article[SYM_SERVER_PATCH]([
          { op: "replace", path: "/author/name", value: "Alice" },
          { op: "add", path: "/author/avatar", value: "new" },
        ]);

        expect(events[0]?.ops).toEqual([
          { op: "add", path: "/author/avatar", value: "new" },
        ]);
      });

      it("replaces changed same-id plain projections without retaining stale fields", () => {
        const article = Article.hydrate(adapter, {
          id: "article-1",
          author: { id: "a1", name: "stale", avatar: "old" },
        });
        const before = article.author;
        const fresh = Article.hydrate(adapter, {
          id: "article-1",
          author: { id: "a1", name: "fresh" },
        });

        article[SYM_SERVER_MERGE](fresh);

        expect((article as any).$author).toBe("a1");
        expect(article.author === before).toBe(false);
        expect((article.author as any).name).toBe("fresh");
        expect((article.author as any).avatar).toBeUndefined();
      });
    });
  });
});
