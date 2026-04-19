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
      if (!model?.on) return () => {};
      model.on("saving", onChange);
      model.on("patched", onChange);
      model.on("saved", onChange);
      return () => {
        model.off("saving", onChange);
        model.off("patched", onChange);
        model.off("saved", onChange);
      };
    },
    [model],
  );

  const getSnapshot = useCallback(
    () => (model?.__savingCount ?? 0) > 0,
    [model],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
