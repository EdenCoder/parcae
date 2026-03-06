"use client";

import { useMemo } from "react";
import { useParcae } from "./context";

export function useApi() {
  const { client } = useParcae();

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
  return useParcae().client;
}

/**
 * useConnectionStatus — connection + auth state.
 */
export function useConnectionStatus() {
  const { client, authState } = useParcae();
  return {
    isConnected: client.isConnected,
    isLoading: client.isLoading,
    authState,
  };
}

/**
 * useAuthState — just the auth state.
 */
export function useAuthState() {
  return useParcae().authState;
}
