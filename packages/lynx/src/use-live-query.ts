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
  total: 0,
  answers: 0,
  drawn: false,
};

/**
 * Subscribe a component to a live store. `enabled: false` draws nothing and does not retain or
 * fetch the store; enabled again, it draws what the store holds at once.
 */
export function useLiveQuery<T extends LiveRow>(
  store: LiveQueryStore<T>,
  enabled = true,
): LiveSnapshot<T> {
  const [, redraw] = useState(0);

  useEffect(() => {
    "background only";
    if (!enabled) return;
    const update = () => redraw((count) => count + 1);
    update();
    return store.retain(update);
  }, [store, enabled]);

  return enabled ? store.snapshot() : EMPTY_SNAPSHOT;
}
