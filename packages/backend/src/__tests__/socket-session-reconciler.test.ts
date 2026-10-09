import { describe, expect, it, vi } from "vitest";

import { SocketSessionReconciler } from "../socket-session-reconciler";

interface Session {
  userId: string;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("SocketSessionReconciler", () => {
  it("does not let a slow prior-user hello restore the session after sign-out", async () => {
    const reconciler = new SocketSessionReconciler<Session>();
    await reconciler.reconcile(async () => ({ userId: "user-1" }));

    const slowUserOne = deferred<Session | null>();
    const priorHello = reconciler.reconcile(() => slowUserOne.promise);
    expect(reconciler.session).toBeNull();

    const signOut = await reconciler.reconcile(async () => null);
    expect(signOut).toEqual({ applied: true, session: null });

    slowUserOne.resolve({ userId: "user-1" });
    await expect(priorHello).resolves.toEqual({
      applied: false,
      session: null,
    });
    expect(reconciler.session).toBeNull();
  });

  it("keeps the newest authenticated hello when an older one resolves later", async () => {
    const reconciler = new SocketSessionReconciler<Session>();
    const slowUserOne = deferred<Session | null>();
    const priorHello = reconciler.reconcile(() => slowUserOne.promise);

    await expect(
      reconciler.reconcile(async () => ({ userId: "user-2" })),
    ).resolves.toEqual({
      applied: true,
      session: { userId: "user-2" },
    });

    slowUserOne.resolve({ userId: "user-1" });
    await expect(priorHello).resolves.toEqual({
      applied: false,
      session: { userId: "user-2" },
    });
    expect(reconciler.session).toEqual({ userId: "user-2" });
  });

  it("invalidates captured work as soon as a newer hello starts", async () => {
    const reconciler = new SocketSessionReconciler<Session>();
    await reconciler.reconcile(async () => ({ userId: "user-1" }));
    const userOne = reconciler.capture();
    expect(userOne).not.toBeNull();
    const pendingSession = deferred<Session | null>();
    const hello = reconciler.reconcile(() => pendingSession.promise);

    expect(reconciler.capture()).toBeNull();
    expect(reconciler.isCurrent(userOne!)).toBe(false);
    pendingSession.resolve({ userId: "user-2" });
    await hello;
    expect(reconciler.isCurrent(userOne!)).toBe(false);
  });

  it("drops late custom-handler output after the socket changes owner", async () => {
    const reconciler = new SocketSessionReconciler<Session>();
    await reconciler.reconcile(async () => ({ userId: "user-1" }));
    const operation = reconciler.capture()!.operation;
    expect(typeof operation).toBe("number");
    const releaseHandler = deferred<void>();
    const emitted: Array<{ event: string; owner: string }> = [];

    const handler = (async () => {
      await releaseHandler.promise;
      reconciler.runIfOperationCurrent(operation, () => {
        emitted.push({ event: "clinical:result", owner: "user-1" });
      });
    })();

    await reconciler.reconcile(async () => ({ userId: "user-2" }));
    releaseHandler.resolve(undefined);
    await handler;

    expect(emitted).toEqual([]);
  });

  it("releases a stale resync acknowledgement without returning prior-owner data", async () => {
    const reconciler = new SocketSessionReconciler<Session>();
    await reconciler.reconcile(async () => ({ userId: "user-1" }));
    const snapshot = reconciler.capture()!;
    const query = deferred<Array<{ owner: string }>>();
    const acknowledge = vi.fn();

    const resync = (async () => {
      const results = await query.promise;
      const current = reconciler.runIfCurrent(snapshot, () => {
        acknowledge({ success: true, results });
      });
      if (!current) {
        acknowledge({ success: false, error: "Session changed" });
      }
    })();

    await reconciler.reconcile(async () => ({ userId: "user-2" }));
    query.resolve([{ owner: "user-1" }]);
    await resync;

    expect(acknowledge).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith({
      success: false,
      error: "Session changed",
    });
    expect(JSON.stringify(acknowledge.mock.calls)).not.toContain("user-1");
  });
});
