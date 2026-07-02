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

// ─── Shared rAF batcher for `coalesced: true` subscriptions ─────────────────
//
// `coalesced: true` says "wake me at most once per animation frame
// instead of synchronously on every model `change` event." A naive
// implementation schedules a fresh `requestAnimationFrame` per
// subscriber, which doesn't actually coalesce — N subscribers
// produce N independent rAF callbacks in the same paint frame, each
// firing its own React render path. With ~150 atomic subscribers
// on a busy editor surface that pile-up takes the main thread away
// for hundreds of milliseconds per frame, exactly the freeze the
// option was meant to prevent.
//
// The fix: one module-level rAF callback drains every queued notify
// in a single pass. Subscribers add to a Set, the first add schedules
// the rAF, subsequent adds piggy-back on the pending tick. React 18
// auto-batches all the resulting state updates into one render.

const coalescedNotifies = new Set<() => void>();
let coalescedRaf: number | null = null;

function flushCoalesced(): void {
  coalescedRaf = null;
  const queue = Array.from(coalescedNotifies);
  coalescedNotifies.clear();
  for (const cb of queue) {
    try {
      cb();
    } catch (err) {
      // Surface but keep draining — one listener throwing must not
      // strand the rest of the batch.
      console.error("[parcae] coalesced notify threw", err);
    }
  }
}

/**
 * Add `notify` to the shared rAF batch. Same notify added twice in
 * one frame deduplicates via Set semantics; the next animation
 * frame fires `notify()` once. Safe to call from any tick.
 *
 * Exported so workspace-level hooks (e.g. `useAssets`'s field-
 * listener wake path) share the same single rAF as parcae's atomic
 * subscribers — without this, every layer of subscribers would
 * schedule its own rAF and the editor would drown in per-subscriber
 * animation-frame callbacks.
 */
export function scheduleCoalesced(notify: () => void): void {
  coalescedNotifies.add(notify);
  if (coalescedRaf !== null) return;
  if (typeof requestAnimationFrame !== "function") {
    // SSR / non-DOM runtimes — fall through to immediate so tests
    // and server renders still settle synchronously.
    flushCoalesced();
    return;
  }
  coalescedRaf = requestAnimationFrame(flushCoalesced);
}

/**
 * Remove `notify` from the pending batch. Called from the
 * subscribe-cleanup path when a consumer unmounts before its
 * coalesced rAF fires.
 *
 * Doesn't cancel the rAF itself — other queued subscribers still
 * need that flush.
 */
export function cancelCoalesced(notify: () => void): void {
  coalescedNotifies.delete(notify);
}

export interface UseModelAtomicOptions<V = unknown> {
  compareFn?: (a: V, b: V) => boolean;
  /** Delay change notifications by N ms, resetting on each model change. */
  debounce?: number;
  /**
   * Coalesce rapid change events to **one** notification per animation
   * frame (~16ms). Subscribers receive a single notify after the next
   * paint regardless of how many `"change"` events fired in the
   * interim. The hook reads the model's current state at flush time,
   * so the rendered value reflects the LAST patch in the window.
   *
   * Trade-off vs. `debounce: 16`: `debounce` is a trailing-edge timer
   * that resets on each event (a stream of events that never quiets
   * for 16ms postpones the notify indefinitely). `coalesced: true`
   * uses `requestAnimationFrame`, which fires once per frame no
   * matter how dense the event stream is — the natural rhythm for
   * UI that doesn't need sub-frame fidelity.
   *
   * Use when the consumer renders into the DOM and a 1-frame lag is
   * invisible (status badges, loading dots, label flicker). Don't use
   * for audio playback control, click handlers, optimistic UI that
   * the user is actively driving.
   *
   * Ignored when `debounce > 0` is also set (debounce wins).
   */
  coalesced?: boolean;
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
  const coalesced =
    typeof compareFnOrOptions === "function"
      ? !!options.coalesced
      : !!compareFnOrOptions?.coalesced;

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
      // Three notify shapes, in priority order:
      //   1. `debounce` — trailing-edge timer, resets per event.
      //   2. `coalesced` — queue into the module-level rAF batcher
      //      so N subscribers waking in the same frame fire ONE
      //      shared rAF that drains every queued notify.
      //   3. immediate — pass through.
      let notify: () => void;
      if (debounceMs > 0) {
        notify = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            cb();
          }, debounceMs);
        };
      } else if (coalesced) {
        notify = () => scheduleCoalesced(cb);
      } else {
        notify = cb;
      }
      model.on("change", notify);
      return () => {
        if (timer) clearTimeout(timer);
        if (coalesced) cancelCoalesced(cb);
        model.off("change", notify);
      };
    },
    [model, isReactive, debounceMs, coalesced],
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
 * Atomic read of the same `path` from N models in one hook call.
 *
 * Returns an array of values, aligned by position to the input
 * `models` array. `null` / `undefined` entries in `models` produce
 * `undefined` in the corresponding result slot (and don't
 * subscribe). Zero-length input is allowed and returns the empty
 * array — useful for "I have a possibly-empty list of models, read
 * `status` from each" patterns without conditional hook calls.
 *
 * # Identity stability
 *
 * The returned array is the same reference across renders when
 * every position's value is `Object.is`-equal to the prior render.
 * One re-render per real value move, regardless of how many models
 * are in the array.
 *
 * # Why
 *
 * The pattern "I have N models, I want to react to one field
 * across all of them" used to require N separate `useModelAtomic`
 * calls — which is illegal under rules-of-hooks if N is dynamic.
 * Block-level aggregators (`hasUnread / hasDirty / hasLoading`)
 * wanted exactly this shape. `useModelsAtomic(blockAssets,
 * "status")` is the rules-of-hooks-safe version.
 *
 * # Behavior on models array changes
 *
 * The hook re-subscribes when the input `models` array identity
 * changes. Pass an identity-stable array (e.g. from another
 * `useSyncExternalStore`-backed source) so subscriptions don't
 * thrash on every render.
 *
 * @param models  Array of models (or null/undefined slots).
 * @param path    Dot-notation field path, applied to each model.
 * @param compareFnOrOptions  Per-position equality / coalesce
 *   options. Same shape as `useModelAtomic`.
 */
export function useModelsAtomic<V = unknown>(
  models: readonly (Model | null | undefined)[],
  path: string,
  compareFnOrOptions?: CompareOrOptions<V>,
  options: UseModelAtomicOptions<V> = {},
): readonly (V | undefined)[] {
  const explicitCompareFn =
    typeof compareFnOrOptions === "function"
      ? compareFnOrOptions
      : compareFnOrOptions?.compareFn;
  const debounce =
    typeof compareFnOrOptions === "function"
      ? options.debounce
      : compareFnOrOptions?.debounce;
  const debounceMs = Math.max(0, debounce ?? 0);
  const coalesced =
    typeof compareFnOrOptions === "function"
      ? !!options.coalesced
      : !!compareFnOrOptions?.coalesced;
  const compareFn =
    explicitCompareFn ?? (defaultEqual as (a: V, b: V) => boolean);

  const subscribe = useCallback(
    (cb: () => void) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let notify: () => void;
      if (debounceMs > 0) {
        notify = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            cb();
          }, debounceMs);
        };
      } else if (coalesced) {
        notify = () => scheduleCoalesced(cb);
      } else {
        notify = cb;
      }
      const subscribed: Model[] = [];
      for (const model of models) {
        if (!isLiveModel(model)) continue;
        model.on("change", notify);
        subscribed.push(model);
      }
      return () => {
        if (timer) clearTimeout(timer);
        if (coalesced) cancelCoalesced(cb);
        for (const model of subscribed) {
          model.off("change", notify);
        }
      };
    },
    [models, debounceMs, coalesced],
  );

  // Identity-stable cache: same length AND every position's value
  // `Object.is`- or compareFn-equal to the cached entry → reuse the
  // prior array reference so consumers' useMemo / useEffect deps
  // bail. New array only when a real value moved.
  const cacheRef = useRef<readonly (V | undefined)[]>(
    EMPTY_VALUES as readonly (V | undefined)[],
  );

  const getSnapshot = useCallback((): readonly (V | undefined)[] => {
    const cached = cacheRef.current;
    if (models.length === 0) {
      if (cached.length === 0) return cached;
      const empty = EMPTY_VALUES as readonly (V | undefined)[];
      cacheRef.current = empty;
      return empty;
    }
    const next: (V | undefined)[] = new Array(models.length);
    let same = cached.length === models.length;
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const value = model ? (getAtPath(model, path) as V | undefined) : undefined;
      next[i] = value;
      if (!same) continue;
      const prev = cached[i];
      if (Object.is(prev, value)) continue;
      if (prev === undefined || value === undefined) {
        same = false;
        continue;
      }
      if (!compareFn(prev, value)) {
        same = false;
        continue;
      }
      // Structurally equal — keep the cached reference at this slot
      // (matches single-model `useModelAtomic` semantics).
      next[i] = prev;
    }
    if (same) return cached;
    const frozen = Object.freeze(next) as readonly (V | undefined)[];
    cacheRef.current = frozen;
    return frozen;
  }, [models, path, compareFn]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const EMPTY_VALUES: readonly unknown[] = Object.freeze([]);

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
