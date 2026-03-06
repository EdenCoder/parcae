"use client";

import { useMemo } from "react";
import { useSnapshot } from "valtio";
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

export function useSDK() {
  return useParcae();
}

export function useConnectionStatus() {
  const client = useParcae();
  const transport = client.transport as any;
  const authState = transport?.auth?.state;
  const snap = authState ? useSnapshot(authState) : null;
  return {
    isConnected: client.isConnected,
    authStatus: (snap as any)?.status ?? "pending",
  };
}

export function useAuthState() {
  const client = useParcae();
  const transport = client.transport as any;
  const authState = transport?.auth?.state;
  const snap = authState ? useSnapshot(authState) : null;
  return {
    status: (snap as any)?.status ?? "pending",
    userId: (snap as any)?.userId ?? null,
    version: (snap as any)?.version ?? 0,
  };
}
