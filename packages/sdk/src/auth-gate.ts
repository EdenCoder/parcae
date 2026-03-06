/**
 * AuthGate — resettable deferred promise for authentication state.
 *
 * - resolve(): auth confirmed (authenticated or confirmed unauthenticated)
 * - reset(): back to pending (reconnect, token change)
 * - ready: awaitable promise that resolves when auth is confirmed
 */

export type AuthGateState = "pending" | "ready";

export class AuthGate {
  private _state: AuthGateState = "pending";
  private _resolve: (() => void) | null = null;
  private _promise: Promise<void>;

  constructor() {
    this._promise = this._makePending();
  }

  get state(): AuthGateState {
    return this._state;
  }

  get ready(): Promise<void> {
    return this._promise;
  }

  resolve(): void {
    this._state = "ready";
    if (this._resolve) {
      this._resolve();
      this._resolve = null;
    }
  }

  reset(): void {
    if (this._state === "ready") {
      this._state = "pending";
      this._promise = this._makePending();
    }
  }

  private _makePending(): Promise<void> {
    return new Promise<void>((r) => {
      this._resolve = r;
    });
  }
}
