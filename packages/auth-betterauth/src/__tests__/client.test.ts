import { describe, expect, it, vi } from "vitest";
import { createAuthClient } from "better-auth/react";
import { betterAuth } from "../client.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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
});
