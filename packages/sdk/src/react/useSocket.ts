"use client";

/**
 * useSocket() — React hook for raw Socket.IO event communication.
 *
 * Provides `emit()` for sending events and `on()` / `off()` for listening.
 * All events go through the existing authenticated Socket.IO connection.
 *
 * @example
 * ```tsx
 * const socket = useSocket();
 *
 * useEffect(() => {
 *   return socket.on("chat:chunk", (data) => console.log(data));
 * }, []);
 *
 * socket.emit("chat:message", { text: "hello" });
 * ```
 */

import { useMemo } from "react";
import { useParcae } from "./context";

export interface SocketHook {
  /** Emit a Socket.IO event to the server. */
  emit: (event: string, ...args: any[]) => void;
  /** Listen for a Socket.IO event. Returns an unsubscribe function. */
  on: (event: string, handler: (...args: any[]) => void) => () => void;
  /** Remove a specific listener for a Socket.IO event. */
  off: (event: string, handler?: (...args: any[]) => void) => void;
}

export function useSocket(): SocketHook {
  const client = useParcae();
  return useMemo(
    () => ({
      emit: (event: string, ...args: any[]) => client.send(event, ...args),
      on: (event: string, handler: (...args: any[]) => void) =>
        client.subscribe(event, handler),
      off: (event: string, handler?: (...args: any[]) => void) =>
        client.unsubscribe(event, handler),
    }),
    [client],
  );
}
