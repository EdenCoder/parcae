"use client";

import { useMemo } from "react";
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
  return { isConnected: client.isConnected, authStatus: status };
}
