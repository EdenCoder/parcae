"use client";

/**
 * Internal hook to read auth state reactively.
 *
 * Subscribes to AuthGate.subscribe() which fires synchronously on every
 * resolve / resolveUnauthenticated / reset call.  We deliberately avoid
 * valtio's snapshot() and subscribe() helpers because their internal proxy
 * metadata (Symbol-keyed iterable state) is stripped when the proxy
 * crosses module/bundler boundaries (Turbopack, Next.js RSC), causing
 * "proxyState is not iterable".
 */

import { useCallback, useRef, useSyncExternalStore } from "react";
import { useParcae } from "./context";
import type { AuthGate } from "../auth-gate";
import type { AuthStatus } from "../auth-gate";

interface AuthSnap {
  status: AuthStatus;
  userId: string | null;
  version: number;
}

const DEFAULT_SNAP: AuthSnap = { status: "pending", userId: null, version: 0 };

/** Read current values directly from the state object. */
function readState(gate: AuthGate): AuthSnap {
  const s = gate.state;
  return {
    status: s.status,
    userId: s.userId,
    version: s.version,
  };
}

export function useAuthStatus(): AuthSnap {
  const client = useParcae();
  const transport = client.transport as any;
  const gate: AuthGate | undefined = transport?.auth;

  // Mutable ref that caches the latest snapshot.  getSnapshot returns
  // this reference — it only changes when the gate notifies us.
  const ref = useRef<AuthSnap>(gate ? readState(gate) : DEFAULT_SNAP);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!gate) return () => {};
      return gate.subscribe(() => {
        ref.current = readState(gate);
        onChange();
      });
    },
    [gate],
  );

  const getSnapshot = useCallback(() => {
    // On first render (or if gate appeared between renders), sync the ref.
    if (gate) {
      const s = gate.state;
      if (
        ref.current.version !== s.version ||
        ref.current.status !== s.status
      ) {
        ref.current = readState(gate);
      }
    }
    return ref.current;
  }, [gate]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
