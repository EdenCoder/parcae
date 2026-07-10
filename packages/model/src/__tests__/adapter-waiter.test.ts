import { describe, expect, it } from "vitest";

import { Model } from "../Model";
import type { ModelAdapter, QueryChain } from "../adapters/types";

function adapter(): ModelAdapter {
  return {
    save: async () => {},
    remove: async () => {},
    findById: async () => null,
    query: () => ({}) as QueryChain<any>,
    patch: async () => {},
  };
}

describe("constructor adapter waiters", () => {
  it("resolves Post.waitForAdapter on Post.use without resolving siblings", async () => {
    class Post extends Model {
      static type = "waiting-post" as const;
    }
    class Comment extends Model {
      static type = "waiting-comment" as const;
    }
    const postAdapter = adapter();
    const commentAdapter = adapter();
    let commentResolved = false;
    const postWait = Post.waitForAdapter();
    const commentWait = Comment.waitForAdapter().then((resolved) => {
      commentResolved = true;
      return resolved;
    });

    Post.use(postAdapter);
    await expect(postWait).resolves.toBe(postAdapter);
    await Promise.resolve();
    expect(commentResolved).toBe(false);

    Comment.use(commentAdapter);
    await expect(commentWait).resolves.toBe(commentAdapter);
  });
});
