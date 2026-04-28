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
 * Accepts `null` / `undefined` — the hook is inert in that case,
 * so conditional consumers stay ergonomic.
 */

import { Model, SYM_VERSION } from "@parcae/model";
import { useCallback, useSyncExternalStore } from "react";

export function useModel<T extends Model>(
  model: T | null | undefined,
): T | null | undefined {
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

  const getSnapshot = useCallback(
    () => (model ? ((model as any)[SYM_VERSION] as number) || 0 : 0),
    [model],
  );

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return model;
}
