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

export function useSDK() {
  return useParcae().client;
}

export function useConnectionStatus() {
  const { client, authState } = useParcae();
  return { isConnected: client.isConnected, authState };
}

export function useAuthState() {
  return useParcae().authState;
}
