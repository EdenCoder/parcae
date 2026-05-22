/**
 * ConnectionMachine — *Is the wire usable right now?*
 *
 * Pure transport-state. No identity, no subscription bookkeeping.
 * The state mirrors the socket lifecycle and lets consumers
 * (offline banners, retry UI) subscribe to connectivity without
 * caring who's logged in.
 *
 * Disconnect must never trigger auth changes. The session and
 * connection lives are orthogonal: a TCP blip doesn't sign anyone
 * out, and a sign-out doesn't drop the socket.
 */
import { log } from "./log";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected";

export interface ConnectionState {
  status: ConnectionStatus;
  /** Last error from socket / hello / resync, if any. */
  lastError: Error | null;
  /** Monotonic counter — bumped on every state change. */
  version: number;
  /** Wall-clock ms of the most recent `connected` transition. */
  lastConnectedAt: number | null;
}

export class ConnectionMachine {
  public state: ConnectionState = {
    status: "idle",
    lastError: null,
    version: 0,
    lastConnectedAt: null,
  };

  private _listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  connecting(): void {
    this._set("connecting", null);
  }

  connected(): void {
    this.state.lastConnectedAt = Date.now();
    this._set("connected", null);
  }

  disconnected(err: Error | null = null): void {
    this._set("disconnected", err);
  }

  private _set(status: ConnectionStatus, err: Error | null): void {
    if (this.state.status === status && this.state.lastError === err) return;
    this.state.status = status;
    this.state.lastError = err;
    this.state.version++;
    log.debug(
      `connection: ${status}${err ? ` (${err.message})` : ""}`,
    );
    for (const fn of this._listeners) fn();
  }
}
