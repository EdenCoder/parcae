"use client";

/**
 * useSaving — returns true when a Model instance has in-flight save/patch operations.
 *
 * Reads `model.__savingCount` and listens for "patched"/"saved" events
 * to re-render when the count changes.
 */

import { useState, useEffect } from "react";

export function useSaving(model: any): boolean {
  const [saving, setSaving] = useState(false);

  // effect
  useEffect(() => {
    // check on
    if (!model) return;
    setSaving(model?.__savingCount);
    model.on("__saving", setSaving);
    return () => {
      model.off("__saving", setSaving);
    };
  }, [model]);

  return saving;
}
