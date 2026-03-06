/**
 * AuthGate — reactive auth state via Valtio proxy.
 *
 * The transport writes to this directly. React reads via useSnapshot().
 * No useState, no useEffect, no manual syncing.
 */

import { log } from "./log";
import { proxy } from "valtio";

export type AuthStatus = "pending" | "authenticated" | "unauthenticated";

export interface AuthState {
  status: AuthStatus;
  userId: string | null;
  version: number;
}

export class AuthGate {
  /** Reactive state — subscribe with valtio useSnapshot() */
  public state = proxy<AuthState>({
    status: "pending",
    userId: null,
    version: 0,
  });

  /** Awaitable — resolves when auth is confirmed (either way) */
  public ready: Promise<void>;

  private _resolve: (() => void) | null = null;

  constructor() {
    this.ready = this._makePending();
  }

  /** Auth confirmed — user is authenticated */
  resolve(userId: string): void {
    this.state.status = "authenticated";
    log.info("auth: authenticated, userId:", userId);
    this.state.userId = userId;
    this.state.version++;
    this._resolve?.();
    this._resolve = null;
  }

  /** Auth confirmed — no user */
  resolveUnauthenticated(): void {
    this.state.status = "unauthenticated";
    log.info("auth: unauthenticated");
    this.state.userId = null;
    this.state.version++;
    this._resolve?.();
    this._resolve = null;
  }

  /** Reset to pending (disconnect, token change) */
  reset(): void {
    if (this.state.status !== "pending") {
      this.state.status = "pending";
    log.info("auth: reset to pending");
      this.state.userId = null;
      this.ready = this._makePending();
    }
  }

  private _makePending(): Promise<void> {
    return new Promise<void>((r) => {
      this._resolve = r;
    });
  }
}
