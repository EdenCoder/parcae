"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useParcae } from "./context";
import { useAuthStatus } from "./useAuth";

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

export function useSDK() {
  return useParcae();
}

export function useConnectionStatus() {
  const client = useParcae();
  const { status } = useAuthStatus();

  // Subscribe to transport connect/disconnect events so React re-renders
  // when the connection state changes.
  const subscribe = useCallback(
    (onChange: () => void) => {
      client.on("connected", onChange);
      client.on("disconnected", onChange);
      return () => {
        client.off("connected", onChange);
        client.off("disconnected", onChange);
      };
    },
    [client],
  );

  const getSnapshot = useCallback(() => client.isConnected, [client]);

  const isConnected = useSyncExternalStore(subscribe, getSnapshot, () => false);

  return { isConnected, authStatus: status };
}
