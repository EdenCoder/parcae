"use client";

/**
 * `useModel(model)` — re-render this component whenever any data
 * property on `model` mutates.
 *
 * Every Parcae Model emits `"change"` on each mutation (both via
 * the Proxy set trap on direct writes AND via `SYM_SERVER_MERGE`
 * on server patches, guarded by an `Object.is` no-op filter). This
 * hook pipes that signal through `useSyncExternalStore` so React
 * re-renders when — and only when — THIS specific model changed.
 *
 * Pairs with `useQuery`, which emits only on array membership
 * changes (add / remove / reorder). Consumers wrap their row-level
 * components with `useModel(model)` to receive field-level updates
 * independently of the parent's render cascade.
 *
 * Usage:
 *
 *   function Message({ msg }: { msg: ChatMessage }) {
 *     useModel(msg);
 *     return <div>{msg.content}</div>;
 *   }
 *
 * Accepts `null` / `undefined` — the hook is inert in that case.
 *
 * Also accepts plain objects that *look* like model rows but aren't
 * full instances (typically projections from a custom REST endpoint
 * passed into a card wrapper that normally hydrates parcae rows).
 * Those don't emit any change events, so the hook short-circuits to
 * a no-op subscription — the component still re-renders normally
 * when its parent passes new props. This keeps wrappers like
 * `<PerformerCard performer={…}>` reusable for both live parcae
 * rows and HTTP snapshots without forcing two variants.
 */

import { Model, SYM_VERSION } from "@parcae/model";
import { useCallback, useSyncExternalStore } from "react";

export function useModel<T extends Model>(
  model: T | null | undefined,
): T | null | undefined {
  // Detect "real" Model instances by their EventEmitter surface. Plain
  // objects from an HTTP envelope are valid input but inert.
  const isReactive = isLiveModel(model);

  const subscribe = useCallback(
    (cb: () => void) => {
      if (!isReactive || !model) return () => {};
      model.on("change", cb);
      return () => {
        model.off("change", cb);
      };
    },
    [model, isReactive],
  );

  const getSnapshot = useCallback(
    () =>
      isReactive && model ? ((model as any)[SYM_VERSION] as number) || 0 : 0,
    [model, isReactive],
  );

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return model;
}

function isLiveModel(model: unknown): model is Model {
  if (!model || typeof model !== "object") return false;
  const m = model as { on?: unknown; off?: unknown };
  return typeof m.on === "function" && typeof m.off === "function";
}
