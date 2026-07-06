/**
 * Lifecycle wiring tests — fake client + fake adapter. Verifies the
 * ParcaeProvider-equivalent semantics: refresh vs terminate on token
 * change, store resets on identity transitions, refetch on resync.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetLifecycleForTests, startLifecycle } from "../lifecycle";
import { createLiveQuery, type QueryChain } from "../live-query";

interface Row {
  id?: string;
  tmp?: string;
}

function makeFakeClient(initialUserId: string | null = null) {
  const sessionListeners = new Set<() => void>();
  const events = new Map<string, Set<() => void>>();
  const state = { userId: initialUserId, status: "pending", version: 0 };
  return {
    refreshSession: vi.fn().mockResolvedValue({ userId: "u1" }),
    terminateSession: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
    session: {
      state,
      subscribe(cb: () => void) {
        sessionListeners.add(cb);
        return () => sessionListeners.delete(cb);
      },
    },
    on(event: string, cb: () => void) {
      if (!events.has(event)) events.set(event, new Set());
      events.get(event)!.add(cb);
    },
    // Test drivers:
    setUserId(userId: string | null) {
      state.userId = userId;
      for (const cb of sessionListeners) cb();
    },
    fire(event: string) {
      for (const cb of events.get(event) ?? []) cb();
    },
  };
}

function makeAdapter() {
  let handler: ((token: string | null) => void) | null = null;
  return {
    adapter: {
      init: () => {},
      getToken: async () => null,
      onChange(cb: (token: string | null) => void) {
        handler = cb;
        return () => {
          handler = null;
        };
      },
    },
    changeToken(token: string | null) {
      handler?.(token);
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

let client: ReturnType<typeof makeFakeClient>;
let auth: ReturnType<typeof makeAdapter>;

beforeEach(() => {
  __resetLifecycleForTests();
  client = makeFakeClient();
  auth = makeAdapter();
  startLifecycle(() => client as never, auth.adapter);
});

describe("startLifecycle", () => {
  it("is idempotent", () => {
    const second = makeAdapter();
    startLifecycle(() => client as never, second.adapter);
    second.changeToken("tok");
    expect(client.refreshSession).not.toHaveBeenCalled();
  });

  it("refreshes the session on a new token, terminates on null", () => {
    auth.changeToken("tok-1");
    expect(client.refreshSession).toHaveBeenCalledOnce();
    expect(client.terminateSession).not.toHaveBeenCalled();

    auth.changeToken(null);
    expect(client.terminateSession).toHaveBeenCalledOnce();
  });

  it("resets live stores when the session identity changes", async () => {
    let calls = 0;
    const chain: QueryChain<Row> = {
      find: async () => {
        calls++;
        return [];
      },
    };
    const store = createLiveQuery<Row>(() => chain);
    const release = store.retain(() => {});
    await flush();
    expect(calls).toBe(1);

    client.setUserId("u1"); // anonymous → signed in
    await flush();
    expect(calls).toBe(2);

    client.setUserId("u1"); // no identity change — no reset
    await flush();
    expect(calls).toBe(2);

    client.setUserId(null); // sign-out
    await flush();
    expect(calls).toBe(3);

    release();
  });

  it("refetches live stores on resync-required", async () => {
    let calls = 0;
    const chain: QueryChain<Row> = {
      find: async () => {
        calls++;
        return [];
      },
    };
    const store = createLiveQuery<Row>(() => chain);
    const release = store.retain(() => {});
    await flush();

    client.fire("resync-required");
    await flush();
    expect(calls).toBe(2);

    release();
  });
});
