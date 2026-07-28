import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthClient } from "better-auth/react";
import { betterAuth } from "../client.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

/**
 * Minimal `document` stand-in for the `visibilitychange` fallback —
 * this package's vitest config has no DOM environment.
 */
function stubDocument() {
  const handlers = new Set<() => void>();
  const doc = {
    visibilityState: "visible",
    addEventListener(event: string, handler: () => void) {
      if (event === "visibilitychange") handlers.add(handler);
    },
    removeEventListener(event: string, handler: () => void) {
      if (event === "visibilitychange") handlers.delete(handler);
    },
  };
  vi.stubGlobal("document", doc);
  return {
    /** Blur then return to the tab. */
    revisit() {
      doc.visibilityState = "hidden";
      for (const handler of [...handlers]) handler();
      doc.visibilityState = "visible";
      for (const handler of [...handlers]) handler();
    },
  };
}

describe("betterAuth client", () => {
  it("ignores stale and post-unsubscribe session reads", async () => {
    type SessionResult = {
      data: { session: { token: string } };
    };
    const primed = deferred<SessionResult>();
    const stale = deferred<SessionResult>();
    const current = deferred<SessionResult>();
    const late = deferred<SessionResult>();
    const reads = [primed, stale, current, late];
    let listener: (() => void) | null = null;
    const client = {
      getSession: vi.fn(() => reads.shift()!.promise),
      $store: {
        atoms: {
          $sessionSignal: {
            listen(next: () => void) {
              listener = next;
              return () => {
                listener = null;
              };
            },
          },
        },
      },
    } as unknown as ReturnType<typeof createAuthClient>;
    const adapter = betterAuth({ client });
    const callback = vi.fn();
    const unsubscribe = adapter.onChange!(callback);

    listener!();
    listener!();
    current.resolve({ data: { session: { token: "new" } } });
    await Promise.resolve();
    stale.resolve({ data: { session: { token: "old" } } });
    await Promise.resolve();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("new");

    listener!();
    unsubscribe();
    late.resolve({ data: { session: { token: "late" } } });
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not report a sign-out when an anonymous tab regains focus", async () => {
    const tab = stubDocument();
    const client = {
      getSession: vi.fn(async () => ({ data: null })),
    } as unknown as ReturnType<typeof createAuthClient>;
    const adapter = betterAuth({ client });
    // The hello handshake reads the token before the tab is ever
    // blurred — that read is the baseline the fallback compares to.
    expect(await adapter.getToken()).toBeNull();

    const callback = vi.fn();
    adapter.onChange!(callback);
    tab.revisit();
    await vi.waitFor(() => expect(client.getSession).toHaveBeenCalledTimes(2));

    // Still anonymous — nothing changed, so nothing to report. Firing
    // `null` here reads as an explicit sign-out and terminates the
    // Parcae session, which blanks every mounted query.
    expect(callback).not.toHaveBeenCalled();
  });

  it("still reports a sign-out that happened in another tab", async () => {
    const tab = stubDocument();
    const sessions = [
      { data: { session: { token: "abc" } } },
      { data: null },
    ];
    const client = {
      getSession: vi.fn(async () => sessions.shift() ?? { data: null }),
    } as unknown as ReturnType<typeof createAuthClient>;
    const adapter = betterAuth({ client });
    expect(await adapter.getToken()).toBe("abc");

    const callback = vi.fn();
    adapter.onChange!(callback);
    tab.revisit();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(null));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});
