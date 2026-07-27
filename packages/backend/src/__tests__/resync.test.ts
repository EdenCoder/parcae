import { Model } from "@parcae/model";
import { describe, expect, it, vi } from "vitest";
import { resyncQueries } from "../app";
import { QuerySubscriptionManager } from "../services/subscriptions";

class ResyncProject extends Model {
  static override type = "resync-project";
  static override scope = {
    read: () => ({}),
  };
}

class DeniedProject extends Model {
  static override type = "denied-project";
  static override scope = {
    read: () => null,
  };
}

function resultQuery(items: Record<string, unknown>[]) {
  const query: any = {
    __modelType: ResyncProject.type,
    exec: () => ({
      toSQL: () => ({ sql: "SELECT * FROM projects", bindings: [] }),
    }),
    clone: () => query,
    find: async () =>
      items.map((item) => ({
        sanitize: async () => item,
      })),
  };
  return query;
}

describe("resyncQueries", () => {
  it("rejects an oversized static batch before any database work", async () => {
    const queryFromClient = vi.fn();
    const entries = Array.from({ length: 4 }, (_, index) => ({
      key: `static-${index}`,
      modelType: ResyncProject.type,
      steps: [],
      subscribe: false,
    }));

    await expect(
      resyncQueries(
        "socket-1",
        "socket-1:operation-1",
        { user: { id: "user-1" } } as any,
        entries,
        { queryFromClient } as any,
        new Map([[ResyncProject.type, ResyncProject as any]]),
        () => true,
        3,
      ),
    ).rejects.toMatchObject({
      status: 429,
      message: "Resync query limit exceeded",
    });
    expect(queryFromClient).not.toHaveBeenCalled();
  });

  it("returns an explicit fail-closed result for a denied query", async () => {
    const results = await resyncQueries(
      "socket-1",
      "socket-1:operation-1",
      { user: { id: "user-1" } } as any,
      [
        {
          key: "denied",
          modelType: DeniedProject.type,
          steps: [],
        },
      ],
      {} as any,
      new Map([[DeniedProject.type, DeniedProject as any]]),
      () => true,
    );

    expect(results).toEqual([
      {
        key: "denied",
        hash: null,
        items: [],
        totalCount: 0,
        authorized: false,
      },
    ]);
  });

  it("rolls back earlier batch subscriptions when a later entry fails", async () => {
    const subscriptions = new QuerySubscriptionManager(
      vi.fn((_socketId: string, _event: string, _data: any) => {}),
      {
        debounceMs: 0,
        maxWaitMs: 0,
      },
    );
    const failure = new Error("second count failed");
    const chains = [
      resultQuery([{ id: "p1" }]),
      { count: vi.fn().mockResolvedValue(1) },
      resultQuery([{ id: "p2" }]),
      { count: vi.fn().mockRejectedValue(failure) },
    ];
    const adapter: any = {
      subscriptions,
      queryFromClient: vi.fn(() => chains.shift()),
    };

    await expect(
      resyncQueries(
        "socket-1",
        "socket-1:operation-1",
        { user: { id: "user-1" } } as any,
        [
          {
            key: "first",
            modelType: ResyncProject.type,
            steps: [],
          },
          {
            key: "second",
            modelType: ResyncProject.type,
            steps: [],
          },
        ],
        adapter,
        new Map([[ResyncProject.type, ResyncProject as any]]),
        () => true,
      ),
    ).rejects.toBe(failure);

    expect(subscriptions.stats).toEqual({
      queries: 0,
      subscribers: 0,
      sockets: 0,
    });
  });

  it("rolls back the latest generation for duplicate hashes in one batch", async () => {
    const subscriptions = new QuerySubscriptionManager(
      vi.fn((_socketId: string, _event: string, _data: any) => {}),
      {
        debounceMs: 0,
        maxWaitMs: 0,
      },
    );
    const failure = new Error("third count failed");
    const chains = [
      resultQuery([{ id: "p1" }]),
      { count: vi.fn().mockResolvedValue(1) },
      resultQuery([{ id: "p1" }]),
      { count: vi.fn().mockResolvedValue(1) },
      resultQuery([{ id: "p2" }]),
      { count: vi.fn().mockRejectedValue(failure) },
    ];
    const adapter: any = {
      subscriptions,
      queryFromClient: vi.fn(() => chains.shift()),
    };

    await expect(
      resyncQueries(
        "socket-1",
        "socket-1:operation-1",
        { user: { id: "user-1" } } as any,
        [
          { key: "first", modelType: ResyncProject.type, steps: [] },
          { key: "duplicate", modelType: ResyncProject.type, steps: [] },
          { key: "failure", modelType: ResyncProject.type, steps: [] },
        ],
        adapter,
        new Map([[ResyncProject.type, ResyncProject as any]]),
        () => true,
      ),
    ).rejects.toBe(failure);

    expect(subscriptions.stats).toEqual({
      queries: 0,
      subscribers: 0,
      sockets: 0,
    });
  });

  it("does not reclaim an attachment adopted between duplicate entries", async () => {
    const subscriptions = new QuerySubscriptionManager(
      vi.fn((_socketId: string, _event: string, _data: any) => {}),
      {
        debounceMs: 0,
        maxWaitMs: 0,
      },
    );
    const failure = new Error("third count failed");
    let releaseDuplicate: () => void = () => undefined;
    const duplicateCount = new Promise<number>((resolve) => {
      releaseDuplicate = () => resolve(1);
    });
    const chains = [
      resultQuery([{ id: "p1" }]),
      { count: vi.fn().mockResolvedValue(1) },
      resultQuery([{ id: "p1" }]),
      { count: vi.fn(() => duplicateCount) },
      resultQuery([{ id: "p2" }]),
      { count: vi.fn().mockRejectedValue(failure) },
    ];
    const adapter: any = {
      subscriptions,
      queryFromClient: vi.fn(() => chains.shift()),
    };
    const registry = new Map([[ResyncProject.type, ResyncProject as any]]);

    const batch = resyncQueries(
      "socket-1",
      "socket-1:operation-1",
      { user: { id: "user-1" } } as any,
      [
        { key: "first", modelType: ResyncProject.type, steps: [] },
        { key: "duplicate", modelType: ResyncProject.type, steps: [] },
        { key: "failure", modelType: ResyncProject.type, steps: [] },
      ],
      adapter,
      registry,
      () => true,
    );
    const batchRejected = expect(batch).rejects.toBe(failure);
    await vi.waitFor(() =>
      expect(adapter.queryFromClient).toHaveBeenCalledTimes(4),
    );

    const adopted = await subscriptions.subscribe({
      socketId: "socket-1",
      sessionLease: "socket-1:operation-1",
      principal: { id: "user-1" },
      query: resultQuery([{ id: "external" }]),
    });
    expect(adopted.subscriptionCreated).toBe(false);
    expect(adopted.attachmentOwnedByCaller).toBe(false);

    releaseDuplicate();
    await batchRejected;

    expect(subscriptions.stats).toEqual({
      queries: 1,
      subscribers: 1,
      sockets: 1,
    });
  });

  it("rejects overlapping same-lease floods and clears the active guard", async () => {
    const subscriptions = new QuerySubscriptionManager(
      vi.fn((_socketId: string, _event: string, _data: any) => {}),
      {
        debounceMs: 0,
        maxWaitMs: 0,
      },
    );
    const failure = new Error("first batch failed");
    let rejectFirst: (reason: Error) => void = () => undefined;
    const delayedFailure = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
    const chains = [
      resultQuery([{ id: "p1" }]),
      { count: vi.fn().mockResolvedValue(1) },
      resultQuery([{ id: "p2" }]),
      { count: vi.fn(() => delayedFailure) },
      resultQuery([{ id: "p3" }]),
      { count: vi.fn().mockResolvedValue(1) },
    ];
    const adapter: any = {
      subscriptions,
      queryFromClient: vi.fn(() => chains.shift()),
    };
    const entries = [
      { key: "first", modelType: ResyncProject.type, steps: [] },
      { key: "failure", modelType: ResyncProject.type, steps: [] },
    ];
    const registry = new Map([[ResyncProject.type, ResyncProject as any]]);

    const first = resyncQueries(
      "socket-1",
      "socket-1:operation-1",
      { user: { id: "user-1" } } as any,
      entries,
      adapter,
      registry,
      () => true,
    );
    const firstRejected = expect(first).rejects.toBe(failure);
    await vi.waitFor(() =>
      expect(adapter.queryFromClient).toHaveBeenCalledTimes(4),
    );

    const overlaps = Array.from({ length: 20 }, (_, index) =>
      resyncQueries(
        "socket-1",
        `socket-1:operation-${index + 2}`,
        { user: { id: "user-1" } } as any,
        entries,
        adapter,
        registry,
        () => true,
      ),
    );
    await Promise.all(
      overlaps.map((overlap) =>
        expect(overlap).rejects.toMatchObject({
          status: 409,
          message: "Resync already in progress",
        }),
      ),
    );
    expect(adapter.queryFromClient).toHaveBeenCalledTimes(4);

    rejectFirst(failure);
    await firstRejected;
    expect(subscriptions.stats).toEqual({
      queries: 0,
      subscribers: 0,
      sockets: 0,
    });

    await expect(
      resyncQueries(
        "socket-1",
        "socket-1:operation-1",
        { user: { id: "user-1" } } as any,
        [{ key: "after", modelType: ResyncProject.type, steps: [] }],
        adapter,
        registry,
        () => true,
      ),
    ).resolves.toMatchObject([
      {
        key: "after",
        authorized: true,
      },
    ]);
    expect(adapter.queryFromClient).toHaveBeenCalledTimes(6);
    expect(subscriptions.stats).toEqual({
      queries: 1,
      subscribers: 1,
      sockets: 1,
    });
  });
});
