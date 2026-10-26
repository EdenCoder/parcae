"use client";

import type { ReadonlySignal } from "@preact/signals-core";
import { useCallback, useSyncExternalStore } from "react";

/** A signal's value in render; the component renders again when it moves. */
export function useSignalValue<T>(source: ReadonlySignal<T>): T {
  const subscribe = useCallback((notify: () => void) => source.subscribe(notify), [source]);
  const read = useCallback(() => source.peek(), [source]);
  return useSyncExternalStore(subscribe, read, read);
}
