"use client";

/**
 * useSaving — returns true when a Model instance has in-flight save/patch operations.
 *
 * Reads `model.__savingCount` and listens for "patched"/"saved" events
 * to re-render when the count changes.
 */

import { useCallback, useSyncExternalStore } from "react";

export function useSaving(model: any): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!model) return () => {};
      model.on("__saving", onChange);
      return () => model.off("__saving", onChange);
    },
    [model],
  );
  const getSnapshot = useCallback(
    () => Boolean(model?.__savingCount),
    [model],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
