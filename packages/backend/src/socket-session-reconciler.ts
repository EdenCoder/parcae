/**
 * Per-socket session state with latest-started reconciliation semantics.
 *
 * Starting a hello clears the previous session immediately. If an older token
 * resolution completes after a newer hello has started, its result is ignored.
 * This prevents a slow pre-sign-out token from restoring the prior user's
 * authorization after the anonymous hello has completed.
 *
 * @internal
 */
export interface SocketSessionSnapshot<T> {
  operation: number;
  session: T | null;
}

export class SocketSessionReconciler<T> {
  private operation = 0;
  private current: T | null = null;
  private ready = false;

  get session(): T | null {
    return this.current;
  }

  get isReady(): boolean {
    return this.ready;
  }

  capture(): SocketSessionSnapshot<T> | null {
    if (!this.ready) return null;
    return { operation: this.operation, session: this.current };
  }

  isCurrent(snapshot: SocketSessionSnapshot<T>): boolean {
    return (
      this.isOperationCurrent(snapshot.operation) &&
      snapshot.session === this.current
    );
  }

  /**
   * Fence delayed output with a primitive only. Unlike a full snapshot, this
   * token can be captured by acknowledgement/emitter wrappers without
   * retaining the prior AuthSession object.
   */
  isOperationCurrent(operation: number): boolean {
    return this.ready && operation === this.operation;
  }

  runIfCurrent(
    snapshot: SocketSessionSnapshot<T>,
    action: () => void,
  ): boolean {
    if (!this.isCurrent(snapshot)) return false;
    action();
    return true;
  }

  runIfOperationCurrent(operation: number, action: () => void): boolean {
    if (!this.isOperationCurrent(operation)) return false;
    action();
    return true;
  }

  async reconcile(
    resolveSession: () => Promise<T | null>,
  ): Promise<{ applied: boolean; session: T | null }> {
    const operation = ++this.operation;
    this.current = null;
    this.ready = false;
    const resolved = await resolveSession();

    if (operation !== this.operation) {
      return { applied: false, session: this.current };
    }

    this.current = resolved;
    this.ready = true;
    return { applied: true, session: this.current };
  }

  invalidate(): void {
    this.operation++;
    this.current = null;
    this.ready = false;
  }
}
