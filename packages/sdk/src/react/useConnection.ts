"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import { useParcae } from "./context";
import type {
  ConnectionMachine,
  ConnectionState,
  ConnectionStatus,
} from "../connection-machine";

const DEFAULT_SNAP: ConnectionState = {
  status: "idle",
  lastError: null,
  version: 0,
  lastConnectedAt: null,
};

function read(machine: ConnectionMachine | undefined): ConnectionState {
  if (!machine) return DEFAULT_SNAP;
  const s = machine.state;
  return {
    status: s.status,
    lastError: s.lastError,
    version: s.version,
    lastConnectedAt: s.lastConnectedAt,
  };
}

export interface UseConnectionResult {
  status: ConnectionStatus;
  isConnected: boolean;
  lastError: Error | null;
  lastConnectedAt: number | null;
}

/**
 * Subscribe to the transport's connection state — *is the wire up*.
 * Re-renders on socket lifecycle transitions only; session changes
 * do NOT trigger a re-render.
 */
export function useConnection(): UseConnectionResult {
  const client = useParcae();
  const machine = client.connection;

  const ref = useRef<ConnectionState>(read(machine));

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
  return {
    status: snap.status,
    isConnected: snap.status === "connected",
    lastError: snap.lastError,
    lastConnectedAt: snap.lastConnectedAt,
  };
}
