/**
 * ReactLynx binding for live query stores. Kept separate from
 * live-query.ts so the store core stays importable (and testable)
 * without a Lynx runtime.
 */

import { useEffect, useState } from "@lynx-js/react";

import type { LiveQueryStore, LiveRow, LiveSnapshot } from "./live-query";

/**
 * Subscribe a component to a live store. `enabled: false` renders the
 * current snapshot without retaining (no fetch is triggered) — use it
 * to keep anonymous surfaces from firing owner-scoped queries.
 */
export function useLiveQuery<T extends LiveRow>(
  store: LiveQueryStore<T>,
  enabled = true,
): LiveSnapshot<T> {
  const [snap, setSnap] = useState<LiveSnapshot<T>>(() => store.snapshot());

  useEffect(() => {
    "background only";
    if (!enabled) return;
    setSnap(store.snapshot());
    return store.retain(() => setSnap(store.snapshot()));
  }, [store, enabled]);

  return snap;
}
