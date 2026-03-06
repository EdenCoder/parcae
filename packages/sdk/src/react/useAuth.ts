"use client";

/**
 * Internal hook to read auth state reactively.
 * No Valtio — just reads the gate state and re-renders when it changes.
 */

import { useState, useEffect } from "react";
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

  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!gate) return;
    let mounted = true;
    const check = () => {
      if (mounted) forceRender((n) => n + 1);
    };
    gate.ready.then(check);
    return () => {
      mounted = false;
    };
  }, [gate, gate?.state?.version]);

  return {
    status: gate?.state?.status ?? "pending",
    userId: gate?.state?.userId ?? null,
    version: gate?.state?.version ?? 0,
  };
}
