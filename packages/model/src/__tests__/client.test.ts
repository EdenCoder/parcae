import { describe, expect, it, vi } from "vitest";
import { Model, SYM_SERVER_MERGE } from "../Model";
import { FrontendAdapter, type Transport } from "../adapters/client";

class Post extends Model {
  static type = "post" as const;
  title: string = "";
  owner: string = "";
  serverDefault: string = "";
}

function createTransport(overrides: Partial<Transport> = {}): Transport {
  return {
    get: async () => null,
    post: async () => null,
    put: async () => null,
    patch: async () => null,
    delete: async () => null,
    ...overrides,
  };
}

describe("FrontendAdapter authoritative writes", () => {
  it("merges the root POST response into a new model", async () => {
    const post = vi.fn(async (_path: string, data: Record<string, any>) => ({
      ...data,
      id: "server-id",
      owner: "user-1",
      serverDefault: "hook default",
      createdAt: "2026-07-10T10:00:00.000Z",
      updatedAt: "2026-07-10T10:00:01.000Z",
    }));
    const adapter = new FrontendAdapter(createTransport({ post }));
    const BoundPost = Post.bind(adapter);
    const model = BoundPost.create({ title: "created" });

    await model.save();

    expect(model.id).toBe("server-id");
    expect(model.owner).toBe("user-1");
    expect(model.serverDefault).toBe("hook default");
    expect(model.updatedAt).toBe("2026-07-10T10:00:01.000Z");
    expect(model.__serverSnapshot.owner).toBe("user-1");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("leaves authoritative merging to Model exactly once", async () => {
    const adapter = new FrontendAdapter(
      createTransport({
        put: async (_path, data) => ({ ...data, serverDefault: "server" }),
      }),
    );
    const model = Post.hydrate(adapter, { id: "p1", title: "before" });
    const originalMerge = model[SYM_SERVER_MERGE].bind(model);
    const merge = vi.fn(originalMerge);
    model[SYM_SERVER_MERGE] = merge;

    model.title = "after";
    await model.save();

    expect(model.serverDefault).toBe("server");
    expect(merge).toHaveBeenCalledOnce();
  });

  it("merges the root PUT response into an existing model", async () => {
    const put = vi.fn(async (_path: string, data: Record<string, any>) => ({
      ...data,
      owner: "scope-owner",
      serverDefault: "after-save hook",
      updatedAt: "2026-07-10T11:00:00.000Z",
    }));
    const adapter = new FrontendAdapter(createTransport({ put }));
    const model = Post.hydrate(adapter, {
      id: "p1",
      title: "before",
      owner: "",
      serverDefault: "",
    });
    model.title = "after";

    await model.save();

    expect(model.title).toBe("after");
    expect(model.owner).toBe("scope-owner");
    expect(model.serverDefault).toBe("after-save hook");
    expect(model.updatedAt).toBe("2026-07-10T11:00:00.000Z");
  });

  it("merges the root PATCH response, including canonicalized fields", async () => {
    const patch = vi.fn(async () => ({
      id: "p1",
      title: "canonical title",
      owner: "scope-owner",
      serverDefault: "patch hook",
      createdAt: "2026-07-10T10:00:00.000Z",
      updatedAt: "2026-07-10T12:00:00.000Z",
    }));
    const adapter = new FrontendAdapter(createTransport({ patch }));
    const model = Post.hydrate(adapter, {
      id: "p1",
      title: "before",
      owner: "",
      serverDefault: "",
      createdAt: "2026-07-10T10:00:00.000Z",
      updatedAt: "2026-07-10T10:00:00.000Z",
    });

    await model.patch([
      { op: "replace", path: "/title", value: "client title" },
    ]);

    expect(model.title).toBe("canonical title");
    expect(model.owner).toBe("scope-owner");
    expect(model.serverDefault).toBe("patch hook");
    expect(model.updatedAt).toBe("2026-07-10T12:00:00.000Z");
  });
});

describe("FrontendAdapter findById errors", () => {
  it("maps an explicitly identified 404 to null", async () => {
    const notFound = Object.assign(new Error("missing"), { status: 404 });
    const adapter = new FrontendAdapter(
      createTransport({ get: async () => Promise.reject(notFound) }),
    );

    await expect(adapter.findById(Post, "missing")).resolves.toBeNull();
  });

  it("propagates non-not-found transport errors", async () => {
    const failure = new Error("connection lost");
    const adapter = new FrontendAdapter(
      createTransport({ get: async () => Promise.reject(failure) }),
    );

    await expect(adapter.findById(Post, "p1")).rejects.toBe(failure);
  });
});
