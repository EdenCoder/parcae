"use client";

/**
 * `useModelAtomic(model, path)` — re-render ONLY when the value at
 * `path` on `model` changes.
 *
 * Subscribes to the model's `"change"` event (same signal as
 * `useModel`) but uses `useSyncExternalStore`'s snapshot diffing to
 * skip re-renders when the specific path's value is unchanged.
 * Result: mutating other fields on the same model doesn't trigger
 * this component.
 *
 * Path is dot-notation: `"content"`, `"video.url"`,
 * `"blocks.abc.video.shots"`. Array indices go through as numeric
 * dot parts: `"items.0.name"`.
 *
 * Comparison defaults to `Object.is` — ideal for leaf primitives
 * (strings, numbers, booleans). For paths that resolve to objects,
 * pass `compareFn` to avoid false-positive re-renders when the
 * parent rebuilds the nested object with identical content.
 *
 * Usage:
 *
 *   function VideoPlayer({ block }: { block: Block }) {
 *     const url = useModelAtomic(block, "video.url");
 *     return url ? <video src={url} /> : null;
 *   }
 *
 *   function Shots({ block }: { block: Block }) {
 *     const shots = useModelAtomic(block, "video.shots", deepEqual);
 *     return <ShotList shots={shots} />;
 *   }
 *
 * Accepts `null` / `undefined` model — returns `undefined` and
 * doesn't subscribe.
 */

import { Model } from "@parcae/model";
import { useCallback, useRef, useSyncExternalStore } from "react";

export function useModelAtomic<V = unknown>(
  model: Model | null | undefined,
  path: string,
  compareFn?: (a: V, b: V) => boolean,
): V | undefined {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!model) return () => {};
      model.on("change", cb);
      return () => {
        model.off("change", cb);
      };
    },
    [model],
  );

  // Cache the last returned value so getSnapshot can return the
  // SAME reference when comparison holds. useSyncExternalStore
  // short-circuits re-render when Object.is(prev, next), which
  // relies on reference stability for the skip.
  const cacheRef = useRef<V | undefined>(undefined);

  const getSnapshot = useCallback((): V | undefined => {
    const next = model ? (getAtPath(model, path) as V) : undefined;
    const prev = cacheRef.current;
    const equal = compareFn
      ? prev !== undefined && next !== undefined && compareFn(prev, next)
      : Object.is(prev, next);
    if (equal) return prev;
    cacheRef.current = next;
    return next;
  }, [model, path, compareFn]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Resolve a dot-notation path against an object. Returns
 * `undefined` on any null/undefined segment. No bracket notation —
 * array indices are plain numeric parts (`"items.0.name"`).
 */
function getAtPath(obj: unknown, path: string): unknown {
  if (obj == null || !path) return undefined;
  const parts = path.split(".");
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
