/**
 * Row fields, the settle lane and keyed values as signals.
 *
 * Row data keeps the identity of every value a write did not change, so a
 * field signal compares by reference and moves only when its value moved.
 * Derived work reads these signals in `computed`s: a reader renders when its
 * own value changes, and nothing compares a result to find what stayed.
 */

import { SYM_VERSION } from "@parcae/model";
import { batch, effect, signal, type ReadonlySignal, type Signal } from "@preact/signals-core";

// ─── Fields ──────────────────────────────────────────────────────────────────

interface Emitter {
  on(event: "change", listener: () => void): unknown;
}

interface Watched {
  revision: Signal<number>;
  paths: Map<string, Signal<unknown>>;
}

const watched = new WeakMap<object, Watched>();

function read(row: unknown, path: string): unknown {
  let value: any = row;
  for (const part of path.split(".")) {
    if (value == null) return undefined;
    value = value[part];
  }
  return value;
}

/** A row's signals, kept current by one `"change"` listener for the row's life. */
function watch(row: object): Watched {
  let own = watched.get(row);
  if (!own) {
    const made: Watched = { revision: signal((row as any)[SYM_VERSION] ?? 0), paths: new Map() };
    watched.set(row, (own = made));
    if (typeof (row as Partial<Emitter>).on === "function")
      (row as Emitter).on("change", () =>
        batch(() => {
          made.revision.value = (row as any)[SYM_VERSION];
          for (const [at, slot] of made.paths) slot.value = read(row, at);
        }));
  }
  return own;
}

/** How many times a row has changed, any field; a plain object without `"change"` stays at 0. */
export function revision(row: object): ReadonlySignal<number> {
  return watch(row).revision;
}

/**
 * The value at a dot path of a row, as a signal shared by every reader; a plain object without
 * `"change"` is read once.
 */
export function field<V = unknown>(row: object, path: string): ReadonlySignal<V | undefined> {
  const { paths } = watch(row);
  let slot = paths.get(path);
  if (!slot) paths.set(path, (slot = signal(read(row, path))));
  return slot as ReadonlySignal<V | undefined>;
}

// ─── Settle lane ─────────────────────────────────────────────────────────────

/** The shortest time between two settled moves while rows patch in bursts. */
const SETTLE_MS = 500;

/** A tick starts once input and paint are done, or by the end of the next window. */
const idle = (run: () => void) =>
  typeof requestIdleCallback === "function"
    ? requestIdleCallback(run, { timeout: SETTLE_MS })
    : setTimeout(run);

/** One clock for every settled signal, so projections that read several move in one batch. */
const clock: { at: number; due: Set<() => void>; timer?: ReturnType<typeof setTimeout> } = {
  at: 0,
  due: new Set(),
};

function settle(move: () => void): void {
  clock.due.add(move);
  clock.timer ??= setTimeout(
    () =>
      idle(() => {
        const due = [...clock.due];
        clock.due.clear();
        clock.timer = undefined;
        clock.at = Date.now();
        batch(() => {
          for (const run of due) run();
        });
      }),
    Math.max(0, clock.at + SETTLE_MS - Date.now()),
  );
}

/**
 * `source` on the settle lane: it moves at once after a quiet window, else at the window's end,
 * with every other settled signal that moved. It reads the source's latest value when it moves,
 * so the last change of a burst is never lost and a steady stream never holds it back.
 */
export function settled<T>(source: ReadonlySignal<T>): ReadonlySignal<T> {
  let stop: (() => void) | undefined;
  const move = () => {
    out.value = source.peek();
  };
  const out: Signal<T> = signal(source.peek(), {
    watched() {
      stop = effect(() => {
        if (source.value !== out.peek()) settle(move);
      });
    },
    unwatched() {
      stop?.();
      clock.due.delete(move);
    },
  });
  return out;
}

// ─── Keys ────────────────────────────────────────────────────────────────────

/**
 * One value for each key, made on its first read and shared by every later one. An object key
 * does not keep its value alive.
 */
export function keyed<K, V>(make: (key: K) => V): (key: K) => V {
  const named = new Map<K, V>();
  const owned = new WeakMap<object, V>();
  return (key) => {
    // A WeakMap answers the same has/get/set, for object keys only.
    const made = (typeof key === "object" && key !== null ? owned : named) as Map<K, V>;
    if (!made.has(key)) made.set(key, make(key));
    return made.get(key)!;
  };
}
