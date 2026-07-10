/**
 * Lifecycle wiring tests — fake client + fake adapter. Verifies the
 * ParcaeProvider-equivalent semantics: refresh vs terminate on token
 * change, store resets on identity transitions, refetch on resync.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetLifecycleForTests, startLifecycle } from "../lifecycle";
import { createLiveQuery, type QueryChain } from "../live-query";

interface Row {
  id?: string;
  tmp?: string;
}

type SessionStatus =
  | "pending"
  | "anonymous"
  | "authenticated"
  | "terminated";

function makeFakeClient(
  initialStatus: SessionStatus = "anonymous",
  initialUserId: string | null = null,
) {
  const sessionListeners = new Set<() => void>();
  const events = new Map<string, Set<() => void>>();
  const state = { userId: initialUserId, status: initialStatus, version: 0 };
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
    off(event: string, cb: () => void) {
      events.get(event)?.delete(cb);
    },
    // Test drivers:
    setSession(status: SessionStatus, userId: string | null) {
      state.status = status;
      state.userId = userId;
      state.version++;
      for (const cb of sessionListeners) cb();
    },
    fire(event: string) {
      for (const cb of events.get(event) ?? []) cb();
    },
    sessionListenerCount() {
      return sessionListeners.size;
    },
    eventListenerCount(event: string) {
      return events.get(event)?.size ?? 0;
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
    listenerCount() {
      return handler ? 1 : 0;
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

let client: ReturnType<typeof makeFakeClient>;
let auth: ReturnType<typeof makeAdapter>;
let dispose: () => void;

beforeEach(() => {
  __resetLifecycleForTests();
  client = makeFakeClient();
  auth = makeAdapter();
  dispose = startLifecycle(() => client as never, auth.adapter);
});

afterEach(() => {
  __resetLifecycleForTests();
});

describe("startLifecycle", () => {
  it("is idempotent", () => {
    const second = makeAdapter();
    expect(startLifecycle(() => client as never, second.adapter)).toBe(dispose);
    second.changeToken("tok");
    expect(client.refreshSession).not.toHaveBeenCalled();
  });

  it("disposes every listener and __resetLifecycleForTests tears down", () => {
    expect(auth.listenerCount()).toBe(1);
    expect(client.sessionListenerCount()).toBe(1);
    expect(client.eventListenerCount("resync-required")).toBe(1);

    __resetLifecycleForTests();
    expect(auth.listenerCount()).toBe(0);
    expect(client.sessionListenerCount()).toBe(0);
    expect(client.eventListenerCount("resync-required")).toBe(0);

    auth.changeToken("ignored");
    client.fire("resync-required");
    expect(client.refreshSession).not.toHaveBeenCalled();
  });

  it("allows a new client and adapter after disposal", () => {
    dispose();
    const replacementClient = makeFakeClient();
    const replacementAuth = makeAdapter();
    const replacementDispose = startLifecycle(
      () => replacementClient as never,
      replacementAuth.adapter,
    );

    replacementAuth.changeToken("new-token");
    auth.changeToken("old-token");
    expect(replacementDispose).not.toBe(dispose);
    expect(replacementClient.refreshSession).toHaveBeenCalledOnce();
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

    client.setSession("authenticated", "u1");
    await flush();
    expect(calls).toBe(2);

    client.setSession("authenticated", "u1");
    await flush();
    expect(calls).toBe(2);

    client.setSession("anonymous", null);
    await flush();
    expect(calls).toBe(3);

    release();
  });

  it("clears terminated sessions without refetching until identity resolves", async () => {
    let calls = 0;
    const store = createLiveQuery<Row>(() => ({
      find: async () => {
        calls++;
        return [{ id: `row-${calls}` }];
      },
    }));
    const release = store.retain(() => {});
    await flush();
    expect(calls).toBe(1);

    client.setSession("terminated", null);
    await flush();
    expect(calls).toBe(1);
    expect(store.snapshot()).toMatchObject({ status: "loading", items: [] });

    client.fire("resync-required");
    await flush();
    expect(calls).toBe(1);

    client.setSession("pending", null);
    await flush();
    expect(calls).toBe(1);

    client.setSession("authenticated", "u2");
    await flush();
    expect(calls).toBe(2);
    expect(store.snapshot().items[0]?.id).toBe("row-2");
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

  it("coalesces an identity reset with the immediate resync from one hello", async () => {
    let calls = 0;
    const store = createLiveQuery<Row>(() => ({
      find: async () => {
        calls++;
        return [];
      },
    }));
    const release = store.retain(() => {});
    await flush();
    expect(calls).toBe(1);

    client.setSession("authenticated", "u1");
    client.fire("resync-required");
    await flush();

    expect(calls).toBe(2);
    release();
  });
});
