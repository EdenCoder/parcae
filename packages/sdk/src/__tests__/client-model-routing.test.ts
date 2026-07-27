import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gets: [] as Array<{ url: string; path: string; data: unknown }>,
  posts: [] as Array<{ url: string; path: string; data: unknown }>,
  puts: [] as Array<{ url: string; path: string; data: unknown }>,
  instances: [] as any[],
}));

vi.mock("../transports/socket", () => {
  class TestSession {
    state = {
      status: "authenticated" as
        | "pending"
        | "authenticated"
        | "anonymous"
        | "terminated",
      userId: "test-owner" as string | null,
    };
    ready = Promise.resolve();
    private listeners = new Set<() => void>();

    subscribe(listener: () => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    beginReconciliation(): void {
      this.state.status = "pending";
      for (const listener of [...this.listeners]) listener();
    }
  }

  return {
    SocketTransport: class SocketTransport {
      session = new TestSession();
      connection = { state: { status: "connected" } };
      isConnected = true;
      needsSessionRefresh = false;
      hasTokenResolverLease = false;
      private url: string;

      constructor(config: { url: string }) {
        this.url = config.url;
        mocks.instances.push(this);
      }

      async get(path: string, data: unknown): Promise<unknown> {
        mocks.gets.push({ url: this.url, path, data });
        if (path === "/posts") {
          return {
            posts: [
              {
                id: `post-${this.url}`,
                title: this.url,
                author: {
                  id: "shared-patient",
                  name: `secret-${this.url}`,
                },
              },
            ],
            __queryHash: `hash-${this.url}`,
            totalCount: 1,
          };
        }
        return null;
      }

      async post(path: string, data: unknown): Promise<unknown> {
        mocks.posts.push({ url: this.url, path, data });
        return {};
      }

      async put(path: string, data: unknown): Promise<unknown> {
        mocks.puts.push({ url: this.url, path, data });
        return {};
      }

      patch = vi.fn(async () => ({}));
      delete = vi.fn(async () => ({}));
      subscribe = vi.fn(() => () => undefined);
      unsubscribe = vi.fn();
      send = vi.fn();
      updateTokenResolver = vi.fn();
      acquireTokenResolverLease = vi.fn();
      releaseTokenResolverLease = vi.fn(() => true);
      refreshSession = vi.fn(async () => ({ userId: "test-owner" }));
      awaitSessionReconciled = vi.fn(async () => ({
        userId: "test-owner",
      }));
      terminateSession = vi.fn(async () => undefined);
      resync = vi.fn(async () => []);
      on = vi.fn();
      off = vi.fn();
      disconnect = vi.fn();
      reconnect = vi.fn(async () => undefined);
    },
  };
});

import { Model } from "@parcae/model";
import {
  _getClientModelAdapter,
  createClient,
  createIsolatedClient,
  type ParcaeClient,
} from "../client";
import { __test as useQueryTest, prefetch } from "../react/useQuery";

class Author extends Model {
  static override type = "author" as const;
  name = "";
}

class Post extends Model {
  static override type = "post" as const;
  static override __schema = {
    title: "string",
    author: { kind: "ref", target: Author },
  } as any;
  title = "";
  declare author: Author;
}

const clients = () =>
  (
    globalThis as typeof globalThis & {
      __parcae_clients?: Map<string, ParcaeClient>;
    }
  ).__parcae_clients;

describe("client-scoped model routing", () => {
  afterEach(() => {
    useQueryTest.resetCache();
    clients()?.clear();
    mocks.gets.length = 0;
    mocks.posts.length = 0;
    mocks.puts.length = 0;
    mocks.instances.length = 0;
    vi.clearAllMocks();
  });

  it("routes lazy queries, hydration, direct models, and optimistic models through their owning clients", async () => {
    const primary = createClient({
      url: "https://primary.example",
      getToken: async () => "primary-token",
    });
    const isolated = createIsolatedClient({
      url: "https://isolated.example",
      getToken: async () => "isolated-token",
    });

    const primaryItems = await prefetch(
      primary,
      Post.where("title", "primary"),
    );
    const isolatedChain = Post.where("title", "isolated");
    const isolatedItems = await prefetch(isolated, isolatedChain);

    expect(mocks.gets.map(({ url }) => url)).toEqual([
      "https://primary.example",
      "https://isolated.example",
    ]);
    expect(primaryItems[0]!.title).toBe("https://primary.example");
    expect(isolatedItems[0]!.title).toBe("https://isolated.example");

    await primaryItems[0]!.save();
    await isolatedItems[0]!.save();
    expect(mocks.puts.map(({ url }) => url)).toEqual([
      "https://primary.example",
      "https://isolated.example",
    ]);

    const optimistic = useQueryTest.createOptimistic(isolatedChain, isolated, {
      title: "isolated draft",
    }) as Post;
    await optimistic.save();
    expect(mocks.posts.at(-1)?.url).toBe("https://isolated.example");

    const direct = Post.create({ title: "primary direct model" });
    await direct.save();
    expect(mocks.posts.at(-1)?.url).toBe("https://primary.example");

    const primaryAdapter = _getClientModelAdapter(primary)!;
    const directHydrated = Post.hydrate(primaryAdapter, {
      id: "direct",
      title: "direct",
      author: { id: "shared-patient", name: "Direct patient secret" },
    });
    const retainedRef = directHydrated.author;
    expect(retainedRef.name).toBe("Direct patient secret");

    mocks.instances[0].session.beginReconciliation();

    expect(() => retainedRef.name).toThrow(
      "Model reference invalidated by an authorization boundary",
    );
  });
});
