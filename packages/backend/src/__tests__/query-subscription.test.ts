import { describe, expect, it, vi } from "vitest";
import { runQuerySubscription } from "../services/query-subscription";
import { QuerySubscriptionManager } from "../services/subscriptions";

function queryReturning(items: Record<string, unknown>[]) {
  const query: any = {
    __modelType: "project",
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

describe("runQuerySubscription", () => {
  it("does not orphan a cached subscription when count fails", async () => {
    const subscriptions = new QuerySubscriptionManager(
      vi.fn((_socketId: string, _event: string, _data: any) => {}),
      {
        debounceMs: 0,
        maxWaitMs: 0,
      },
    );
    const countError = new Error("count failed");
    const prep: any = {
      query: queryReturning([{ id: "p1" }]),
      countQuery: {
        count: vi.fn().mockRejectedValue(countError),
      },
      expandResolved: [],
      steps: [],
    };

    await expect(
      runQuerySubscription({
        prep,
        socketId: "socket-1",
        sessionLease: "socket-1:operation-1",
        user: { id: "user-1" },
        adapter: { subscriptions } as any,
        isSessionCurrent: () => true,
      }),
    ).rejects.toBe(countError);

    expect(subscriptions.stats).toEqual({
      queries: 0,
      subscribers: 0,
      sockets: 0,
    });
  });
});
