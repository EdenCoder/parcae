"use client";

/**
 * Internal hook to read auth state reactively.
 * Subscribes to valtio proxy changes on the AuthGate state so any
 * status/userId/version mutation triggers a React re-render.
 */

import { useSyncExternalStore } from "react";
import { subscribe as valtioSubscribe, snapshot } from "valtio";
import { useParcae } from "./context";
import type { AuthStatus } from "../auth-gate";

export function useAuthStatus(): {
  status: AuthStatus;
  userId: string | null;
  version: number;
} {
  const client = useParcae();
  const transport = client.transport as any;
  const gate = transport?.auth;
  const state = gate?.state;

  // Subscribe to valtio proxy mutations.
  // valtioSubscribe fires synchronously on any property change.
  const sub = (onChange: () => void) => {
    if (!state) return () => {};
    return valtioSubscribe(state, onChange);
  };

  // Snapshot returns an immutable copy — useSyncExternalStore compares by reference.
  // A new snapshot object is created on every proxy mutation, so Object.is fails
  // and React re-renders.
  const getSnapshot = () => {
    if (!state) return null;
    return snapshot(state);
  };

  const snap = useSyncExternalStore(sub, getSnapshot, getSnapshot);

  return {
    status: (snap as any)?.status ?? "pending",
    userId: (snap as any)?.userId ?? null,
    version: (snap as any)?.version ?? 0,
  };
}
