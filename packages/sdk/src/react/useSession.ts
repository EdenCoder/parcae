"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import { useParcae } from "./context";
import type {
  SessionMachine,
  SessionState,
  SessionStatus,
} from "../session-machine";

const DEFAULT_SNAP: SessionState = {
  status: "pending",
  userId: null,
  version: 0,
};

function read(machine: SessionMachine | undefined): SessionState {
  if (!machine) return DEFAULT_SNAP;
  const s = machine.state;
  return { status: s.status, userId: s.userId, version: s.version };
}

export interface UseSessionResult {
  status: SessionStatus;
  userId: string | null;
}

/**
 * Subscribe to the parcae session — *who is the current user*.
 * Returns `{ status, userId }`. Re-renders on identity transitions
 * only; transport disconnects do NOT trigger a re-render.
 */
export function useSession(): UseSessionResult {
  const client = useParcae();
  const machine = client.session;

  const ref = useRef<SessionState>(read(machine));

  const subscribe = useCallback(
    (onChange: () => void) =>
      machine.subscribe(() => {
        ref.current = read(machine);
        onChange();
      }),
    [machine],
  );

  const getSnapshot = useCallback(() => {
    if (
      ref.current.version !== machine.state.version ||
      ref.current.status !== machine.state.status
    ) {
      ref.current = read(machine);
    }
    return ref.current;
  }, [machine]);

  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { status: snap.status, userId: snap.userId };
}
