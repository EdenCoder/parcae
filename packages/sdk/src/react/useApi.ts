"use client";

import { useMemo } from "react";
import { useParcae } from "./context";
import { useConnection } from "./useConnection";
import { useSession } from "./useSession";

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

/**
 * Combined connection + session snapshot for legacy call sites.
 * Prefer `useConnection()` or `useSession()` directly in new code.
 */
export function useConnectionStatus() {
  const connection = useConnection();
  const session = useSession();
  return {
    isConnected: connection.isConnected,
    sessionStatus: session.status,
  };
}
