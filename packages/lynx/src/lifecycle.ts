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

import type { AuthClientAdapter, ParcaeClient } from "@parcae/sdk";

import { provideClient } from "./client-registry";
import { refetchLiveQueries, resetLiveQueries } from "./live-query";

let started = false;

export function startLifecycle(
  getClient: () => ParcaeClient,
  adapter: AuthClientAdapter,
): void {
  "background only";
  if (started) return;
  started = true;

  provideClient(getClient);
  const client = getClient();

  // Mirrors ParcaeProvider: token rotation → fresh hello on the live
  // socket; sign-out → terminate (queries stop running as the user).
  adapter.onChange((token) => {
    if (token === null) {
      client.terminateSession().catch(() => {});
    } else {
      client.refreshSession().catch(() => {});
    }
  });

  // Identity transitions invalidate every live snapshot — rows were
  // fetched as someone else (or as anonymous).
  let lastUserId = client.session.state.userId;
  client.session.subscribe(() => {
    const now = client.session.state.userId;
    if (now !== lastUserId) {
      lastUserId = now;
      resetLiveQueries();
    }
  });

  // Reconnect re-ran the hello; server-side query subscriptions died
  // with the old socket, so every active store refetches (and picks
  // up a fresh query hash + ops subscription).
  client.on("resync-required", () => refetchLiveQueries());
}

/** @internal — lets tests re-run startLifecycle with fresh spies. */
export function __resetLifecycleForTests(): void {
  started = false;
}
