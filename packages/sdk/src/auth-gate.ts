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

// Diagnostic — counts every AuthGate instance constructed so we can
// detect multiple-transport / multiple-client scenarios in the trace.
let __gateInstanceSeq = 0;

export class AuthGate {
  /** Reactive state — plain object, mutated in place. */
  public state: AuthState = {
    status: "pending",
    userId: null,
    version: 0,
  };

  /** Awaitable — resolves when auth is confirmed (either way) */
  public ready: Promise<void>;

  /** @internal — unique id for tracing. */
  public readonly __id: number;

  private _resolve: (() => void) | null = null;
  private _listeners = new Set<() => void>();

  constructor() {
    this.__id = ++__gateInstanceSeq;
    console.log("[gate DOL-1037] new AuthGate()", {
      gateId: this.__id,
      t: typeof performance !== "undefined" ? performance.now() : Date.now(),
    });
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
    const prevStatus = this.state.status;
    this.state.status = "authenticated";
    log.debug("auth: authenticated, userId:", userId);
    console.log("[gate DOL-1037] resolve(authenticated)", {
      gateId: this.__id,
      prevStatus,
      userId,
      version: this.state.version + 1,
      listeners: this._listeners.size,
      t: performance.now(),
    });
    this.state.userId = userId;
    this.state.version++;
    this._resolve?.();
    this._resolve = null;
    this._notify();
  }

  /** Auth confirmed — no user */
  resolveUnauthenticated(): void {
    const prevStatus = this.state.status;
    this.state.status = "unauthenticated";
    log.debug("auth: unauthenticated");
    console.log("[gate DOL-1037] resolve(unauthenticated)", {
      gateId: this.__id,
      prevStatus,
      version: this.state.version + 1,
      listeners: this._listeners.size,
      t: performance.now(),
    });
    this.state.userId = null;
    this.state.version++;
    this._resolve?.();
    this._resolve = null;
    this._notify();
  }

  /** Reset to pending (disconnect, token change) */
  reset(): void {
    const prevStatus = this.state.status;
    if (prevStatus !== "pending") {
      this.state.status = "pending";
      log.debug("auth: reset to pending");
      console.log("[gate DOL-1037] reset(pending)", {
        gateId: this.__id,
        prevStatus,
        prevUserId: this.state.userId,
        version: this.state.version + 1,
        listeners: this._listeners.size,
        t: performance.now(),
      });
      this.state.userId = null;
      this.state.version++;
      this.ready = this._makePending();
      this._notify();
    } else {
      // Silent no-op path. Logged at debug level so we see when
      // reset gets called redundantly (e.g. multiple disconnects
      // while already pending — would mask the "ready is fresh"
      // suspicion in the t=2500 file-fetch wait observation).
      console.log("[gate DOL-1037] reset(pending) — no-op (already pending)", {
        gateId: this.__id,
        listeners: this._listeners.size,
        t: performance.now(),
      });
    }
  }

  private _notify(): void {
    for (const fn of this._listeners) fn();
  }

  private _makePending(): Promise<void> {
    console.log("[gate DOL-1037] _makePending (new ready promise)", {
      gateId: this.__id,
      t: typeof performance !== "undefined" ? performance.now() : Date.now(),
    });
    return new Promise<void>((r) => {
      this._resolve = r;
    });
  }
}
