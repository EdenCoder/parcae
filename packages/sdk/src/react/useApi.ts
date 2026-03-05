"use client";

/**
 * useApi — pre-bound HTTP methods from the Parcae client.
 *
 * @example
 * ```tsx
 * const { get, post } = useApi();
 * const data = await get("/custom-endpoint");
 * ```
 */

import { useMemo } from "react";
import { useParcae } from "./context";

export function useApi() {
  const client = useParcae();

  return useMemo(
    () => ({
      get: client.get.bind(client),
      post: client.post.bind(client),
      put: client.put.bind(client),
      patch: client.patch.bind(client),
      delete: client.delete.bind(client),
    }),
    [client],
  );
}

/**
 * useSDK — raw client instance.
 */
export function useSDK() {
  return useParcae();
}

/**
 * useConnectionStatus — reactive connection state.
 */
export function useConnectionStatus() {
  const client = useParcae();
  // This is a snapshot — for true reactivity, components should
  // listen to client.on("connected"/"disconnected") events.
  return {
    isConnected: client.isConnected,
    isLoading: client.isLoading,
  };
}
