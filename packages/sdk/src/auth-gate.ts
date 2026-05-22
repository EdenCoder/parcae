/**
 * AuthGate — auth state container with awaitable resolution.
 *
 * The transport writes to this directly.  React reads via useAuthStatus()
 * which subscribes through gate.subscribe().
 */

import { log } from "./log";

export type AuthStatus = "pending" | "authenticated" | "unauthenticated";

export interface AuthState {
  status: AuthStatus;
  userId: string | null;
  version: number;
}

export class AuthGate {
  /** Reactive state — plain object, mutated in place. */
  public state: AuthState = {
    status: "pending",
    userId: null,
    version: 0,
  };

  /** Awaitable — resolves when auth is confirmed (either way) */
  public ready: Promise<void>;

  private _resolve: (() => void) | null = null;
  private _listeners = new Set<() => void>();

  constructor() {
    this.ready = this._makePending();
  }

  /**
   * Subscribe to state changes.  Returns an unsubscribe function.
   * The callback is invoked synchronously whenever resolve /
   * resolveUnauthenticated / reset mutates the state.
   */
  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  /** Auth confirmed — user is authenticated */
  resolve(userId: string): void {
    this.state.status = "authenticated";
    log.debug("auth: authenticated, userId:", userId);
    this.state.userId = userId;
    this.state.version++;
    this._resolve?.();
    this._resolve = null;
    this._notify();
  }

  /** Auth confirmed — no user */
  resolveUnauthenticated(): void {
    this.state.status = "unauthenticated";
    log.debug("auth: unauthenticated");
    this.state.userId = null;
    this.state.version++;
    this._resolve?.();
    this._resolve = null;
    this._notify();
  }

  /** Reset to pending (disconnect, token change) */
  reset(): void {
    if (this.state.status !== "pending") {
      this.state.status = "pending";
      log.debug("auth: reset to pending");
      this.state.userId = null;
      this.state.version++;
      this.ready = this._makePending();
      this._notify();
    }
  }

  private _notify(): void {
    for (const fn of this._listeners) fn();
  }

  private _makePending(): Promise<void> {
    return new Promise<void>((r) => {
      this._resolve = r;
    });
  }
}
