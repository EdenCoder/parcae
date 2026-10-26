"use client";

/**
 * `useModelAtomic(model, path)` renders again only when the value at `path` moves. Row data keeps
 * the identity of every value a write did not change, so the read compares by reference.
 *
 * Path is dot-notation: `"content"`, `"video.url"`, `"items.0.name"`. A `null` / `undefined`
 * model reads `undefined`.
 */

import { computed, signal } from "@preact/signals-core";
import { useMemo } from "react";

import { field } from "../signals";
import { useSignalValue } from "./useSignalValue";

const NONE = signal(undefined);

export function useModelAtomic<V = unknown>(
  model: object | null | undefined,
  path: string,
): V | undefined {
  return useSignalValue(model ? field<V>(model, path) : NONE) as V | undefined;
}

/**
 * The value at `path` of each model, by position. The array keeps its identity until a value
 * moves; pass an identity-stable `models` array.
 */
export function useModelsAtomic<V = unknown>(
  models: readonly (object | null | undefined)[],
  path: string,
): readonly (V | undefined)[] {
  const values = useMemo(
    () => computed(() => models.map((model) => (model ? field<V>(model, path).value : undefined))),
    [models, path],
  );
  return useSignalValue(values);
}
