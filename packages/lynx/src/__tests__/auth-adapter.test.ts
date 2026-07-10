import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmitterAuthAdapter } from "../auth-adapter";

function makeFakeEmitter() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    addListener(event: string, cb: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
    },
    removeListener(event: string, cb: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(cb);
    },
    emit(event: string) {
      for (const cb of listeners.get(event) ?? []) cb();
    },
    count(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

let emitter: ReturnType<typeof makeFakeEmitter>;

beforeEach(() => {
  emitter = makeFakeEmitter();
  (globalThis as Record<string, unknown>).lynx = {
    getJSModule: (name: string) =>
      name === "GlobalEventEmitter" ? emitter : undefined,
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).lynx;
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("createEmitterAuthAdapter", () => {
  it("resolves the token through the app getter", async () => {
    const adapter = createEmitterAuthAdapter({
      getToken: async () => "tok-1",
    });
    await expect(adapter.getToken()).resolves.toBe("tok-1");
  });

  it("fires onChange with the fresh token when the event emits", async () => {
    let token: string | null = "tok-1";
    const adapter = createEmitterAuthAdapter({ getToken: async () => token });
    const seen: Array<string | null> = [];
    adapter.onChange((t) => seen.push(t));

    emitter.emit("auth.changed");
    await flush();
    token = null;
    emitter.emit("auth.changed");
    await flush();

    expect(seen).toEqual(["tok-1", null]);
  });

  it("retries a transient getter failure without emitting null", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const adapter = createEmitterAuthAdapter({
      getToken: () => {
        reads++;
        return reads === 1
          ? Promise.reject(new Error("native store down"))
          : Promise.resolve("recovered-token");
      },
    });
    const cb = vi.fn();
    adapter.onChange(cb);

    emitter.emit("auth.changed");
    await vi.runAllTimersAsync();

    expect(reads).toBe(2);
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith("recovered-token");
    expect(cb).not.toHaveBeenCalledWith(null);
  });

  it("ignores a persistent getter failure after the retry budget", async () => {
    vi.useFakeTimers();
    const getToken = vi.fn(() =>
      Promise.reject(new Error("native store down")),
    );
    const adapter = createEmitterAuthAdapter({ getToken });
    const cb = vi.fn();
    adapter.onChange(cb);

    emitter.emit("auth.changed");
    await vi.runAllTimersAsync();

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(cb).not.toHaveBeenCalled();
  });

  it("honours a custom event name and unsubscribes cleanly", async () => {
    const adapter = createEmitterAuthAdapter({
      getToken: async () => "t",
      event: "session.rotated",
    });
    const unsub = adapter.onChange(() => {});
    expect(emitter.count("session.rotated")).toBe(1);
    unsub();
    expect(emitter.count("session.rotated")).toBe(0);
  });
});
