/**
 * ReactLynx binding for live query stores. Kept separate from
 * live-query.ts so the store core stays importable (and testable)
 * without a Lynx runtime.
 */

import { useEffect, useState } from "@lynx-js/react";

import type { LiveQueryStore, LiveRow, LiveSnapshot } from "./live-query";

const EMPTY_SNAPSHOT: LiveSnapshot<never> = {
  items: [],
  status: "loading",
  error: null,
};

interface HookState<T extends LiveRow> {
  store: LiveQueryStore<T>;
  snapshot: LiveSnapshot<T>;
}

/**
 * Subscribe a component to a live store. `enabled: false` clears the
 * visible snapshot and does not retain or fetch the store.
 */
export function useLiveQuery<T extends LiveRow>(
  store: LiveQueryStore<T>,
  enabled = true,
): LiveSnapshot<T> {
  const [state, setState] = useState<HookState<T>>(() => ({
    store,
    snapshot: enabled ? store.snapshot() : EMPTY_SNAPSHOT,
  }));

  useEffect(() => {
    "background only";
    if (!enabled) {
      setState({ store, snapshot: EMPTY_SNAPSHOT });
      return;
    }
    const update = () => setState({ store, snapshot: store.snapshot() });
    update();
    return store.retain(update);
  }, [store, enabled]);

  if (!enabled) return EMPTY_SNAPSHOT;
  return state.store === store ? state.snapshot : store.snapshot();
}
