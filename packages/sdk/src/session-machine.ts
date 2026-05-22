/**
 * SessionMachine — *Who is this user?*
 *
 * Identity-only. The session represents the authenticated principal
 * carrying the current token. Its lifetime is the *token's* lifetime,
 * not the transport's. A TCP blip never mutates session state.
 *
 * States:
 *   - `pending`        — initial; no handshake has resolved yet
 *   - `anonymous`      — handshake confirmed no user (no token / rejected)
 *   - `authenticated`  — handshake confirmed `userId`
 *   - `terminated`    — explicit sign-out; the SDK refuses further work
 *                       on this session. (The Provider can hand the
 *                       hook layer a fresh client for a new sign-in.)
 *
 * Transitions are driven by exactly three callers:
 *   - the transport's `hello` ack (one-time at connect / reconnect)
 *   - the auth adapter's `onChange` (token rotation, login, logout)
 *   - `terminate()` (explicit sign-out)
 *
 * No other code path is allowed to mutate session state. In
 * particular: socket connect / disconnect / error do not touch it.
 */
import { log } from "./log";

export type SessionStatus =
  | "pending"
  | "anonymous"
  | "authenticated"
  | "terminated";

export interface SessionState {
  status: SessionStatus;
  userId: string | null;
  /** Monotonic counter — bumped on every state change. */
  version: number;
}

export class SessionMachine {
  public state: SessionState = {
    status: "pending",
    userId: null,
    version: 0,
  };

  /** Resolves the first time the session leaves `pending`. */
  public ready: Promise<void>;

  private _resolveReady: (() => void) | null = null;
  private _listeners = new Set<() => void>();

  constructor() {
    this.ready = new Promise<void>((r) => {
      this._resolveReady = r;
    });
  }

  /** Subscribe to state changes. Returns unsubscribe. */
  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  /**
   * Authoritative result of a hello / token handshake. The caller
   * (transport / Provider) hands us the userId the server confirmed
   * — or `null` if the server said no.
   */
  resolve(userId: string | null): void {
    if (this.state.status === "terminated") return;

    const prev = this.state.userId;
    const nextStatus: SessionStatus = userId ? "authenticated" : "anonymous";

    // No-op when the result confirms what we already knew. Avoids
    // spurious notifies that would re-render every subscriber.
    if (this.state.status === nextStatus && prev === userId) return;

    this.state.status = nextStatus;
    this.state.userId = userId;
    this.state.version++;
    log.debug(
      userId ? `session: authenticated ${userId}` : "session: anonymous",
    );
    this._fireReady();
    this._notify();
  }

  /**
   * Explicit sign-out. The token is dead regardless of socket
   * state. After this the SDK refuses further auth-touching work.
   */
  terminate(): void {
    if (this.state.status === "terminated") return;
    this.state.status = "terminated";
    this.state.userId = null;
    this.state.version++;
    log.debug("session: terminated");
    this._fireReady();
    this._notify();
  }

  /** @internal — exposed for diagnostics. */
  reset(): void {
    if (this.state.status === "pending") return;
    this.state.status = "pending";
    this.state.userId = null;
    this.state.version++;
    this.ready = new Promise<void>((r) => {
      this._resolveReady = r;
    });
    this._notify();
  }

  private _fireReady(): void {
    this._resolveReady?.();
    this._resolveReady = null;
  }

  private _notify(): void {
    for (const fn of this._listeners) fn();
  }
}
