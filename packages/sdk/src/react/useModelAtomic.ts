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
 * # Comparison default — structural deep equality
 *
 * The default compareFn does a *structural deep equality* walk
 * via `@observ33r/object-equals`'s engine-aware comparator —
 * `Object.is` for primitives, recursive same-shape comparison for
 * plain objects / arrays / sets / maps / typed arrays / etc., with
 * fast bail on length / key-count mismatch. This matters because
 * the SDK's server-merge path (`applyOps` in `useQuery.ts`)
 * deep-clones `existing.__data` before calling `SYM_SERVER_MERGE`,
 * which in turn replaces top-level keys (e.g. `this.blocks`) with
 * the fresh-cloned sub-tree. That clone means
 * `Object.is(prev.blocks, next.blocks) === false` after every
 * server push — and worse, every entry inside (`prev.blocks.X !==
 * next.blocks.X`) — so a naive `Object.is` snapshot at any
 * sub-path of `blocks` fires a re-render on every server push,
 * even when the sub-path's data is bit-for-bit identical.
 *
 * Structural equality breaks that cycle: same shape + same leaves
 * → returns the cached `prev` reference → `useSyncExternalStore`
 * short-circuits the re-render. The walk is shallow per-node, deep
 * only where needed; `object-equals` is roughly 3–7× faster than
 * `fast-equals` / `dequal` on the shapes we hit here (block trees
 * with images, status maps, shot arrays).
 *
 * Pass an explicit `compareFn` (or `{ compareFn }`) to override —
 * `Object.is` for raw reference checks, a custom shape-narrowed
 * comparator for hot paths where deep walk is overkill.
 *
 * Pass `{ debounce }` to coalesce rapid model change events before
 * React reads the path snapshot.
 *
 * Usage:
 *
 *   function VideoPlayer({ block }: { block: Block }) {
 *     const url = useModelAtomic(block, "video.url");
 *     return url ? <video src={url} /> : null;
 *   }
 *
 *   function Shots({ block }: { block: Block }) {
 *     // Deep walk is the default — no compareFn needed.
 *     const shots = useModelAtomic(block, "video.shots");
 *     // Or explicit Object.is for hot paths where you've already
 *     // narrowed the snapshot to known-stable primitives:
 *     const url = useModelAtomic(block, "video.url", Object.is);
 *     return <ShotList shots={shots} />;
 *   }
 *
 *   function Blocks({ project }: { project: Project }) {
 *     const blocks = useModelAtomic(project, "blocks", { debounce: 200 });
 *     return <Document blocks={blocks} />;
 *   }
 *
 * Accepts `null` / `undefined` model — returns `undefined` and
 * doesn't subscribe.
 */

import { Model } from "@parcae/model";
import { objectEquals } from "@observ33r/object-equals";
import { useCallback, useRef, useSyncExternalStore } from "react";

export interface UseModelAtomicOptions<V = unknown> {
  compareFn?: (a: V, b: V) => boolean;
  /** Delay change notifications by N ms, resetting on each model change. */
  debounce?: number;
}

type CompareOrOptions<V> =
  | ((a: V, b: V) => boolean)
  | UseModelAtomicOptions<V>;

/**
 * Default comparator — `@observ33r/object-equals` for structural
 * deep equality. Exported so call sites that want the same default
 * outside the hook (test harnesses, derived comparators) can reuse
 * the exact contract.
 *
 * See the module docstring for why structural equality is the
 * right default for path snapshots over `Object.is`.
 */
export function defaultEqual(a: unknown, b: unknown): boolean {
  return objectEquals(a, b);
}

export function useModelAtomic<V = unknown>(
  model: Model | null | undefined,
  path: string,
  compareFnOrOptions?: CompareOrOptions<V>,
  options: UseModelAtomicOptions<V> = {},
): V | undefined {
  const explicitCompareFn =
    typeof compareFnOrOptions === "function"
      ? compareFnOrOptions
      : compareFnOrOptions?.compareFn;
  const debounce =
    typeof compareFnOrOptions === "function"
      ? options.debounce
      : compareFnOrOptions?.debounce;
  const debounceMs = Math.max(0, debounce ?? 0);

  // Default comparator is structural deep equality (see the
  // module docstring for why `Object.is` is wrong here — the
  // server-merge path deep-clones, so every sub-path reference
  // is fresh after every server push, regardless of whether the
  // bits changed).
  const compareFn =
    explicitCompareFn ?? (defaultEqual as (a: V, b: V) => boolean);

  // Mirrors `useModel`'s tolerance for plain-JSON projections. Parcae
  // adapter rows have an EventEmitter surface; HTTP-envelope rows
  // shaped like a model don't. Probing for `.on` lets the hook
  // short-circuit to a noop subscription instead of throwing
  // `model.on is not a function` deep inside an unrelated component.
  const isReactive = isLiveModel(model);

  const subscribe = useCallback(
    (cb: () => void) => {
      if (!isReactive || !model) return () => {};
      let timer: ReturnType<typeof setTimeout> | null = null;
      const notify =
        debounceMs > 0
          ? () => {
              if (timer) clearTimeout(timer);
              timer = setTimeout(() => {
                timer = null;
                cb();
              }, debounceMs);
            }
          : cb;
      model.on("change", notify);
      return () => {
        if (timer) clearTimeout(timer);
        model.off("change", notify);
      };
    },
    [model, isReactive, debounceMs],
  );

  // Cache the last returned value so getSnapshot can return the
  // SAME reference when comparison holds. useSyncExternalStore
  // short-circuits re-render when Object.is(prev, next), which
  // relies on reference stability for the skip.
  const cacheRef = useRef<V | undefined>(undefined);

  const getSnapshot = useCallback((): V | undefined => {
    const next = model ? (getAtPath(model, path) as V) : undefined;
    const prev = cacheRef.current;
    // Fast path: identity match. Skips the deep walk for local
    // patches where parcae preserved the reference, and handles
    // primitives uniformly (Object.is treats NaN/NaN as equal,
    // +0/-0 as not).
    if (Object.is(prev, next)) return prev;
    // If either side just became / left undefined the cache must
    // swap — there's nothing for the comparator to walk.
    if (prev === undefined || next === undefined) {
      cacheRef.current = next;
      return next;
    }
    if (compareFn(prev, next)) {
      // Structurally equal — keep the cached reference so
      // useSyncExternalStore's Object.is check holds and React
      // skips the re-render. Downstream consumers keep their
      // stable reference too, which matters for memoized children
      // and useMemo/useEffect dep arrays.
      return prev;
    }
    cacheRef.current = next;
    return next;
  }, [model, path, compareFn]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function isLiveModel(model: unknown): model is Model {
  if (!model || typeof model !== "object") return false;
  const m = model as { on?: unknown; off?: unknown };
  return typeof m.on === "function" && typeof m.off === "function";
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
