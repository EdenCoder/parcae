/**
 * useQuery — items-array reference contract.
 *
 * `applyOps` is the function that takes a subscription op batch and
 * produces the next cache `items` array. It has three reference-
 * stability regimes that downstream consumers depend on:
 *
 *   1. No-op batch (empty ops, or ops that don't touch any item in
 *      the result set) → return the SAME items reference. Skips
 *      every downstream invalidation.
 *
 *   2. Update-only batch (one or more `op: "update"` matches; no
 *      adds / no removes) → return the SAME items array reference
 *      (DOL-1101). The per-item Model instances are mutated in
 *      place by `SYM_SERVER_MERGE`; the wrapping array doesn't
 *      need to flip. Consumers that need to react to scalar field
 *      changes wake through parcae's per-model `change` event bus
 *      (`useModelAtomic(model, "field")`). Consumers reading the
 *      `items` array for membership/order bail on `Object.is` and
 *      skip the re-render — exactly what we want for status /
 *      readAt / file patches that don't move membership.
 *
 *      Pre-DOL-1101 this regime returned `items.slice()` so
 *      downstream `useMemo([items])` would re-fire on every patch.
 *      That fan-out made the editor unusable on bursty backends:
 *      one job lifecycle (queued → generating → uploading → ready)
 *      flipped the items reference 4× and woke every consumer of
 *      the query 4× with no semantic change. Per-field reactivity
 *      via `useModelAtomic` is the correct way to observe scalar
 *      moves; the items array is for membership.
 *
 *   3. Add / remove batch → return a fresh items array built from
 *      scratch. New reference, new membership.
 *
 * These tests pin the three regimes directly via the public
 * subscription path: a `FakeClient` emits ops, `applyOps` runs
 * inside the subscription handler, and we inspect `entry.items`
 * before and after.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model, SYM_SERVER_MERGE, type Ref } from "@parcae/model";
import { EventEmitter } from "eventemitter3";

import { __test as useQueryTest } from "../react/useQuery";

// ─── Fake Model class ───────────────────────────────────────────────────────

class Post extends Model {
  static type = "post" as const;
  title = "";
  body = "";
  profile: Record<string, any> = {};
}

class Author extends Model {
  static type = "author" as const;
  name = "";
}

class Article extends Model {
  static type = "article" as const;
  static __schema = {
    author: { kind: "ref", target: Author },
  } as any;
  declare author: Ref<Author>;
}

// ─── FakeClient — minimal ParcaeClient surface useQuery touches ─────────────

interface SubscriptionRegistration {
  event: string;
  handler: (...args: any[]) => void;
}

class FakeClient extends EventEmitter {
  public subscriptions: SubscriptionRegistration[] = [];
  public send = vi.fn();

  subscribe(event: string, handler: (...args: any[]) => void): () => void {
    const entry = { event, handler };
    this.subscriptions.push(entry);
    return () => {
      const idx = this.subscriptions.indexOf(entry);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  emitQueryOps(hash: string, ops: unknown[]): void {
    for (const sub of this.subscriptions) {
      if (sub.event === `query:${hash}`) sub.handler(ops);
    }
  }

  /**
   * Mirror the new server envelope shape `{ ops, order? }` that
   * `QuerySubscriptionManager` emits when membership/order changes.
   * The bare-array `emitQueryOps` above is preserved for backward-
   * compat tests against the legacy wire shape.
   */
  emitQueryEnvelope(
    hash: string,
    envelope: { ops: unknown[]; order?: string[] },
  ): void {
    for (const sub of this.subscriptions) {
      if (sub.event === `query:${hash}`) sub.handler(envelope);
    }
  }
}

// ─── chain factory ──────────────────────────────────────────────────────────

function makeChain(opts: {
  results: Array<{
    id: string;
    title?: string;
    body?: string;
    profile?: Record<string, any>;
  }>;
  queryHash: string;
}): any {
  const chain: any = {
    __modelType: "post",
    __modelClass: Post,
    __steps: [{ method: "where", args: [{ status: "active" }] }],
    __adapter: null,
  };

  chain.find = async () => {
    const items = opts.results.map((r) => Post.hydrate({} as any, r));
    Object.defineProperty(items, "__queryHash", {
      value: opts.queryHash,
      enumerable: false,
    });
    Object.defineProperty(items, "__totalCount", {
      value: opts.results.length,
      enumerable: false,
    });
    return items;
  };

  return chain;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function primeCache(
  client: FakeClient,
  hash: string,
  results: Array<{
    id: string;
    title?: string;
    body?: string;
    profile?: Record<string, any>;
  }>,
) {
  const chain = makeChain({ results, queryHash: hash });
  const key = useQueryTest.buildKey("post", "u1", chain.__steps);
  const release = useQueryTest.retain(client as any, key, () => {});
  useQueryTest.fetch(key, chain, client as any);
  await new Promise((r) => setImmediate(r));
  const entry = useQueryTest.getEntry(client as any, key)!;
  return { entry, release };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("useQuery — items-array reference contract", () => {
  beforeEach(() => {
    useQueryTest.resetCache();
  });
  afterEach(() => {
    useQueryTest.resetCache();
  });

  // ── 1. Update-only ops: NEW array reference, SAME per-item refs ───

  it("update-only op returns a NEW items array reference (shallow copy)", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-update", [
      { id: "p1", title: "first" },
      { id: "p2", title: "second" },
    ]);

    const beforeArray = entry.items;
    const beforeP1 = entry.items[0];
    const beforeP2 = entry.items[1];
    const beforeVersion = entry.version;

    client.emitQueryOps("h-update", [
      {
        op: "update",
        id: "p1",
        patch: [{ op: "replace", path: "/title", value: "updated" }],
      },
    ]);

    // DOL-1101: the wrapping array reference STAYS THE SAME on
    // an update-only batch. The per-item models were mutated in
    // place; the array slot is unchanged. Consumers that need
    // scalar reactivity use `useModelAtomic(model, field)`;
    // consumers using `useMemo([items])` correctly bail.
    expect(entry.items).toBe(beforeArray);

    // Per-item Model identity stays stable — `SYM_SERVER_MERGE`
    // mutates the existing instance.
    expect(entry.items[0]).toBe(beforeP1);
    expect(entry.items[1]).toBe(beforeP2);

    // The mutation actually landed on the in-place model.
    expect(entry.items[0].title).toBe("updated");
    // Untouched item is unchanged.
    expect(entry.items[1].title).toBe("second");

    // Version bumps on changed=true so useSyncExternalStore fires.
    // Assert relative — the fetch path itself also bumps version
    // (DOL-1041) so the absolute count isn't 1.
    expect(entry.version).toBeGreaterThan(beforeVersion);

    release();
  });

  it("multiple update ops in one batch preserve the items reference (no shallow copy)", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-multi", [
      { id: "p1", title: "first" },
      { id: "p2", title: "second" },
      { id: "p3", title: "third" },
    ]);

    const beforeArray = entry.items;
    const beforeRefs = entry.items.slice();

    client.emitQueryOps("h-multi", [
      {
        op: "update",
        id: "p1",
        patch: [{ op: "replace", path: "/title", value: "A" }],
      },
      {
        op: "update",
        id: "p3",
        patch: [{ op: "replace", path: "/title", value: "C" }],
      },
    ]);

    // DOL-1101: even multiple update ops keep the items reference.
    // The whole batch lands as in-place mutations through
    // `SYM_SERVER_MERGE`; the array slot is unchanged.
    expect(entry.items).toBe(beforeArray);
    expect(entry.items).toHaveLength(3);
    // Per-item identity preserved across the whole batch.
    for (let i = 0; i < 3; i++) {
      expect(entry.items[i]).toBe(beforeRefs[i]);
    }
    expect(entry.items[0].title).toBe("A");
    expect(entry.items[1].title).toBe("second");
    expect(entry.items[2].title).toBe("C");

    release();
  });

  it("filters parent patches while a nested optimistic child write is pending", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-nested-child", [
      { id: "p1", profile: { name: "server", theme: "light" } },
    ]);
    const post = entry.items[0];
    post.profile = { name: "optimistic", theme: "light" };
    Object.defineProperty(post, "__patchingPaths", {
      configurable: true,
      get: () => new Set(["/profile/name"]),
    });
    const originalMerge = post[SYM_SERVER_MERGE].bind(post);
    const merge = vi.fn(originalMerge);
    post[SYM_SERVER_MERGE] = merge;

    client.emitQueryOps("h-nested-child", [
      {
        op: "update",
        id: "p1",
        patch: [
          {
            op: "replace",
            path: "/profile",
            value: { name: "stale", theme: "dark" },
          },
        ],
      },
    ]);

    expect(post.profile.name).toBe("optimistic");
    expect(merge).not.toHaveBeenCalled();
    release();
  });

  it("filters nested patches while an optimistic parent write is pending", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-nested-parent", [
      { id: "p1", profile: { name: "server" } },
    ]);
    const post = entry.items[0];
    post.profile = { name: "optimistic" };
    Object.defineProperty(post, "__patchingPaths", {
      configurable: true,
      get: () => new Set(["/profile"]),
    });
    const originalMerge = post[SYM_SERVER_MERGE].bind(post);
    const merge = vi.fn(originalMerge);
    post[SYM_SERVER_MERGE] = merge;

    client.emitQueryOps("h-nested-parent", [
      {
        op: "update",
        id: "p1",
        patch: [{ op: "replace", path: "/profile/name", value: "stale" }],
      },
    ]);

    expect(post.profile.name).toBe("optimistic");
    expect(merge).not.toHaveBeenCalled();
    release();
  });

  it("merges one authoritative clone for multiple nested patches", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-nested-batch", [
      { id: "p1", profile: { name: "before", theme: "light" } },
    ]);
    const post = entry.items[0];
    const originalMerge = post[SYM_SERVER_MERGE].bind(post);
    const merge = vi.fn(originalMerge);
    post[SYM_SERVER_MERGE] = merge;

    client.emitQueryOps("h-nested-batch", [
      {
        op: "update",
        id: "p1",
        patch: [{ op: "replace", path: "/profile/name", value: "after" }],
      },
      {
        op: "update",
        id: "p1",
        patch: [{ op: "replace", path: "/profile/theme", value: "dark" }],
      },
    ]);

    expect(merge).toHaveBeenCalledOnce();
    expect(post.profile).toEqual({ name: "after", theme: "dark" });
    release();
  });

  it("replaces a patched expanded ref without replacing its raw id", async () => {
    const client = new FakeClient();
    const adapter = {} as any;
    const chain: any = {
      __modelType: "article",
      __modelClass: Article,
      __steps: [],
      __adapter: adapter,
      find: async () => {
        const rows = [
          Article.hydrate(adapter, {
            id: "article-1",
            author: { id: "author-1", name: "Alice" },
          }),
        ];
        Object.defineProperty(rows, "__queryHash", { value: "expanded" });
        return rows;
      },
    };
    const key = useQueryTest.buildKey("article", "u1", []);
    const release = useQueryTest.retain(client as any, key, () => {});
    useQueryTest.fetch(key, chain, client as any);
    await new Promise((resolve) => setImmediate(resolve));
    const entry = useQueryTest.getEntry(client as any, key)!;
    const article = entry.items[0];
    const author = article.author;

    client.emitQueryOps("expanded", [
      {
        op: "update",
        id: "article-1",
        patch: [
          { op: "replace", path: "/author/name", value: "Alicia" },
        ],
      },
    ]);

    expect(article.$author).toBe("author-1");
    expect(article.author).not.toBe(author);
    expect(article.author.name).toBe("Alicia");
    release();
  });

  it("refreshes a same-id expanded ref while preserving parent identity", async () => {
    const client = new FakeClient();
    const adapter = {} as any;
    const makeArticleChain = (name: string): any => ({
      __modelType: "article",
      __modelClass: Article,
      __steps: [],
      __adapter: adapter,
      find: async () => [
        Article.hydrate(adapter, {
          id: "article-1",
          author: { id: "author-1", name },
        }),
      ],
    });
    const key = useQueryTest.buildKey("article", "u1", []);
    const release = useQueryTest.retain(client as any, key, () => {});
    useQueryTest.fetch(key, makeArticleChain("stale"), client as any);
    await new Promise((resolve) => setImmediate(resolve));
    const entry = useQueryTest.getEntry(client as any, key)!;
    const article = entry.items[0];
    const author = article.author;

    useQueryTest.fetch(key, makeArticleChain("fresh"), client as any);
    await new Promise((resolve) => setImmediate(resolve));

    expect(entry.items[0]).toBe(article);
    expect(article.author).not.toBe(author);
    expect(article.$author).toBe("author-1");
    expect(article.author.name).toBe("fresh");
    release();
  });

  it("reconciles a full fetch into an optimistic id/tmp match", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "optimistic-fetch", []);
    const local = Post.hydrate({} as any, {
      id: "temporary-id",
      tmp: "tmp-1",
      title: "optimistic",
    });
    entry.optimistic.push(local);
    const chain = makeChain({
      results: [{ id: "server-id", title: "canonical" }],
      queryHash: "optimistic-fetch",
    });
    const originalFind = chain.find;
    chain.find = async () => {
      const rows = await originalFind();
      rows[0].tmp = "tmp-1";
      return rows;
    };

    useQueryTest.fetch(entry.key, chain, client as any);
    await new Promise((resolve) => setImmediate(resolve));

    expect(entry.items[0]).toBe(local);
    expect(local.id).toBe("server-id");
    expect(local.title).toBe("canonical");
    expect(entry.optimistic).toEqual([]);
    release();
  });

  // ── 2. No-op batches: SAME array reference ────────────────────────

  it("update op for an id NOT in the result set preserves the items reference", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-noop-id", [
      { id: "p1", title: "first" },
    ]);

    const beforeArray = entry.items;
    const beforeVersion = entry.version;

    // The id "p999" is not in our result set. applyOps must NOT
    // mutate anything and MUST return the same array reference so
    // downstream consumers don't spuriously re-render.
    client.emitQueryOps("h-noop-id", [
      {
        op: "update",
        id: "p999",
        patch: [{ op: "replace", path: "/title", value: "ghost" }],
      },
    ]);

    expect(entry.items).toBe(beforeArray);
    expect(entry.version).toBe(beforeVersion);

    release();
  });

  it("empty ops batch preserves the items reference", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-empty", [
      { id: "p1", title: "first" },
    ]);

    const beforeArray = entry.items;
    const beforeVersion = entry.version;

    client.emitQueryOps("h-empty", []);

    expect(entry.items).toBe(beforeArray);
    expect(entry.version).toBe(beforeVersion);

    release();
  });

  // ── 3. Add / remove ops: NEW array reference, new membership ──────

  it("add op returns a NEW items array reference (membership change)", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-add", [
      { id: "p1", title: "first" },
    ]);

    const beforeArray = entry.items;
    const beforeP1 = entry.items[0];

    client.emitQueryOps("h-add", [
      {
        op: "add",
        id: "p2",
        data: { id: "p2", title: "second" },
      },
    ]);

    expect(entry.items).not.toBe(beforeArray);
    expect(entry.items).toHaveLength(2);
    // Existing item identity preserved.
    expect(entry.items.find((i: any) => i.id === "p1")).toBe(beforeP1);
    // New item present.
    const added = entry.items.find((i: any) => i.id === "p2");
    expect(added).toBeDefined();
    expect(added.title).toBe("second");

    release();
  });

  it("remove op returns a NEW items array reference (membership change)", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-remove", [
      { id: "p1", title: "first" },
      { id: "p2", title: "second" },
    ]);

    const beforeArray = entry.items;
    const beforeP2 = entry.items[1];

    client.emitQueryOps("h-remove", [{ op: "remove", id: "p1" }]);

    expect(entry.items).not.toBe(beforeArray);
    expect(entry.items).toHaveLength(1);
    // Surviving item identity preserved.
    expect(entry.items[0]).toBe(beforeP2);
    expect(entry.items[0].id).toBe("p2");

    release();
  });

  // ── 4. Order envelope (DOL-894) ───────────────────────────────────

  it("envelope with `order` places an `add` in the right slot (insertion middle)", async () => {
    // Server sees the new ordered set `[p1, p2, p3]` after p2 was
    // inserted between p1 and p3. The legacy bare-array path would
    // append p2 to the end. With the envelope's `order` field the
    // client reorders correctly.
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-order-add", [
      { id: "p1", title: "A" },
      { id: "p3", title: "C" },
    ]);

    const beforeP1 = entry.items[0];
    const beforeP3 = entry.items[1];

    client.emitQueryEnvelope("h-order-add", {
      ops: [{ op: "add", id: "p2", data: { id: "p2", title: "B" } }],
      order: ["p1", "p2", "p3"],
    });

    expect(entry.items).toHaveLength(3);
    expect(entry.items.map((i: any) => i.id)).toEqual(["p1", "p2", "p3"]);
    // Identity of existing rows preserved across reorder.
    expect(entry.items[0]).toBe(beforeP1);
    expect(entry.items[2]).toBe(beforeP3);

    release();
  });

  it("envelope with `order` and NO ops still reorders (pure-order change)", async () => {
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-order-only", [
      { id: "p1", title: "A" },
      { id: "p2", title: "B" },
    ]);

    const beforeP1 = entry.items[0];
    const beforeP2 = entry.items[1];

    client.emitQueryEnvelope("h-order-only", {
      ops: [],
      order: ["p2", "p1"],
    });

    expect(entry.items.map((i: any) => i.id)).toEqual(["p2", "p1"]);
    expect(entry.items[0]).toBe(beforeP2);
    expect(entry.items[1]).toBe(beforeP1);

    release();
  });

  it("envelope-shape update without `order` preserves the items reference (DOL-1101)", async () => {
    // Membership stable + order stable → the server omits `order`.
    // Result preserves the items reference; the in-place mutation
    // is visible through the unchanged model identity.
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-env-update", [
      { id: "p1", title: "first" },
      { id: "p2", title: "second" },
    ]);

    const beforeArray = entry.items;

    client.emitQueryEnvelope("h-env-update", {
      ops: [
        {
          op: "update",
          id: "p1",
          patch: [{ op: "replace", path: "/title", value: "updated" }],
        },
      ],
    });

    expect(entry.items).toBe(beforeArray);
    expect(entry.items[0].title).toBe("updated");
    release();
  });

  // ── 5. DOL-1101 — items reference stability across scalar bursts

  it("downstream useMemo-style dep arrays keep their reference across update-only frames (DOL-1101)", async () => {
    // The lockup symptom: a busy backend emits 4 update frames for
    // one job lifecycle (queued → generating → uploading → ready).
    // Pre-DOL-1101 each frame flipped `entry.items` reference, so
    // every `useMemo([items])` consumer recomputed 4× — including
    // bridges that walk 250 blocks per recompute. Post-DOL-1101
    // the items reference is preserved through the burst; scalar
    // reactivity flows through `useModelAtomic` per-model events.
    // This test pins that contract.
    const client = new FakeClient();
    const { entry, release } = await primeCache(client, "h-memo", [
      { id: "p1", title: "first" },
    ]);

    const memoizedDep = entry.items;

    // Burst of 4 scalar updates — simulates a job lifecycle.
    for (const title of ["queued", "generating", "uploading", "after"]) {
      client.emitQueryOps("h-memo", [
        {
          op: "update",
          id: "p1",
          patch: [{ op: "replace", path: "/title", value: title }],
        },
      ]);
    }

    // Items reference unchanged across all 4 frames. A
    // `useMemo([items])` keyed on this reference bails — no work.
    expect(entry.items).toBe(memoizedDep);

    // The mutations all landed on the in-place model. Consumers
    // that need this scalar use `useModelAtomic(model, "title")`,
    // which fires through parcae's per-model `change` event bus.
    expect(entry.items[0].title).toBe("after");

    release();
  });
});
