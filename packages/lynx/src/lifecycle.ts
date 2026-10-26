/**
 * Each page observes the client's identity and reconnects for its own
 * live-query stores. Only the runtime that owns auth supplies an adapter.
 * Listeners stay attached until the page's last caller releases them.
 */

import type {
  AuthClientAdapter,
  ParcaeClient,
  SessionStatus,
} from "@parcae/sdk";

import { provideClient } from "./client-registry";
import { refetchLiveQueries, resetLiveQueries } from "./live-query";

let disposeLifecycle: (() => void) | null = null;
const retainers = new Set<() => void>();

export function startLifecycle(
  getClient: () => ParcaeClient,
  adapter?: AuthClientAdapter,
): () => void {
  "background only";
  if (!disposeLifecycle) {
    provideClient(getClient);
    const client = getClient();

    // Mirrors ParcaeProvider: token rotation → fresh hello on the live
    // socket; sign-out → terminate (queries stop running as the user).
    const unsubChange = adapter?.onChange((token) => {
      if (token !== null) {
        client.refreshSession().catch(() => {});
        return;
      }
      // Only a signed-in session can be signed out of. Terminating an
      // anonymous or still-pending one is sticky and leaves every query
      // reporting "loaded, zero rows" for the rest of the runtime.
      if (client.session.state.status !== "authenticated") return;
      client.terminateSession().catch(() => {});
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
      resetLiveQueries(isReady, userId ?? null);
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

    disposeLifecycle = () => {
      unsubChange?.();
      unsubSession();
      client.off("resync-required", handleResync);
    };
  }

  const release = () => {
    if (!retainers.delete(release) || retainers.size > 0) return;
    disposeLifecycle?.();
    disposeLifecycle = null;
  };
  retainers.add(release);
  return release;
}

/** @internal — lets tests re-run startLifecycle with fresh spies. */
export function __resetLifecycleForTests(): void {
  for (const release of retainers) release();
}
