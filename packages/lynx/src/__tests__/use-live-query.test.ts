import { afterEach, describe, expect, it, vi } from "vitest";

const hookRuntime = vi.hoisted(() => {
  let state: unknown;
  let hasState = false;
  let pendingEffect: (() => void | (() => void)) | null = null;
  let cleanup: (() => void) | null = null;

  return {
    useState(initial: unknown) {
      if (!hasState) {
        state = typeof initial === "function" ? initial() : initial;
        hasState = true;
      }
      return [
        state,
        (next: unknown) => {
          state = next;
        },
      ];
    },
    useEffect(effect: () => void | (() => void)) {
      pendingEffect = effect;
    },
    commit() {
      cleanup?.();
      cleanup = pendingEffect?.() ?? null;
      pendingEffect = null;
    },
    reset() {
      cleanup?.();
      state = undefined;
      hasState = false;
      pendingEffect = null;
      cleanup = null;
    },
  };
});

vi.mock("@lynx-js/react", () => ({
  useEffect: hookRuntime.useEffect,
  useState: hookRuntime.useState,
}));

import type { LiveQueryStore, LiveSnapshot } from "../live-query";
import { useLiveQuery } from "../use-live-query";

interface Row {
  id?: string;
}

function makeStore(id: string) {
  let snapshot: LiveSnapshot<Row> = {
    items: [{ id }],
    status: "ready",
    error: null,
  };
  const listeners = new Set<() => void>();
  const store: LiveQueryStore<Row> = {
    snapshot: () => snapshot,
    retain(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refetch() {},
    addOptimistic() {},
    removeOptimistic() {},
  };
  return {
    store,
    listenerCount: () => listeners.size,
    update(nextId: string) {
      snapshot = { ...snapshot, items: [{ id: nextId }] };
      for (const listener of listeners) listener();
    },
  };
}

afterEach(() => hookRuntime.reset());

describe("useLiveQuery", () => {
  it("synchronizes store changes and clears disabled snapshots immediately", () => {
    const oldStore = makeStore("old-user");
    const newStore = makeStore("new-user");

    expect(useLiveQuery(oldStore.store).items[0]?.id).toBe("old-user");
    hookRuntime.commit();
    expect(oldStore.listenerCount()).toBe(1);
    oldStore.update("old-user-latest");

    expect(useLiveQuery(newStore.store).items[0]?.id).toBe("new-user");
    hookRuntime.commit();
    expect(oldStore.listenerCount()).toBe(0);
    expect(newStore.listenerCount()).toBe(1);

    expect(useLiveQuery(newStore.store, false).items).toEqual([]);
    hookRuntime.commit();
    expect(newStore.listenerCount()).toBe(0);
  });
});
