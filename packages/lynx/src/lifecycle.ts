/**
 * Session lifecycle for Lynx apps — the equivalent of
 * `@parcae/sdk/react`'s ParcaeProvider effects (which can't run on
 * Lynx; see live-query.ts). Owns the socket-session consequences of
 * auth changes:
 *
 *   - adapter `onChange` → refreshSession (token) / terminateSession (null)
 *   - identity change on the session machine → reset live-query stores
 *   - `resync-required` (reconnect hello) → refetch live queries
 *
 * The app supplies its AuthClientAdapter implementation (token custody
 * and the change signal are app concerns — e.g. a native token store
 * bridged over a GlobalEventEmitter event).
 *
 * Idempotent — call from any background effect that touches the client.
 */

import type {
  AuthClientAdapter,
  ParcaeClient,
  SessionStatus,
} from "@parcae/sdk";

import { provideClient } from "./client-registry";
import { refetchLiveQueries, resetLiveQueries } from "./live-query";

let disposeLifecycle: (() => void) | null = null;

export function startLifecycle(
  getClient: () => ParcaeClient,
  adapter: AuthClientAdapter,
): () => void {
  "background only";
  if (disposeLifecycle) return disposeLifecycle;

  provideClient(getClient);
  const client = getClient();

  // Mirrors ParcaeProvider: token rotation → fresh hello on the live
  // socket; sign-out → terminate (queries stop running as the user).
  const unsubChange = adapter.onChange((token) => {
    if (token === null) {
      client.terminateSession().catch(() => {});
    } else {
      client.refreshSession().catch(() => {});
    }
  });

  // Identity transitions invalidate every live snapshot — rows were
  // fetched as someone else (or as anonymous).
  let lastStatus: SessionStatus | null = null;
  let lastUserId: string | null | undefined;
  let didResetThisTurn = false;
  const syncIdentity = () => {
    const { status, userId } = client.session.state;
    if (status === lastStatus && userId === lastUserId) return;
    lastStatus = status;
    lastUserId = userId;
    const isReady = status === "anonymous" || status === "authenticated";
    resetLiveQueries(isReady);
    if (isReady) {
      didResetThisTurn = true;
      queueMicrotask(() => {
        didResetThisTurn = false;
      });
    }
  };
  const unsubSession = client.session.subscribe(syncIdentity);
  syncIdentity();

  // Reconnect re-ran the hello; server-side query subscriptions died
  // with the old socket, so every active store refetches (and picks
  // up a fresh query hash + ops subscription).
  const handleResync = () => {
    const { status } = client.session.state;
    if (status === "anonymous" || status === "authenticated") {
      if (didResetThisTurn) {
        didResetThisTurn = false;
        return;
      }
      refetchLiveQueries();
    }
  };
  client.on("resync-required", handleResync);

  let isDisposed = false;
  const dispose = () => {
    if (isDisposed) return;
    isDisposed = true;
    unsubChange();
    unsubSession();
    client.off("resync-required", handleResync);
    if (disposeLifecycle === dispose) disposeLifecycle = null;
  };
  disposeLifecycle = dispose;
  return dispose;
}

/** @internal — lets tests re-run startLifecycle with fresh spies. */
export function __resetLifecycleForTests(): void {
  disposeLifecycle?.();
}
