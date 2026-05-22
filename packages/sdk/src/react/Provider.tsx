"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { createClient } from "../client";
import type { ParcaeClient, ClientConfig } from "../client";
import type { AuthClientAdapter } from "../auth-adapter";
import { ParcaeContext } from "./context";
import { _purgeCacheForUser } from "./useQuery";
import { log } from "../log";

export interface ParcaeProviderProps {
  /** Pre-created client instance. */
  client?: ParcaeClient;
  /** Backend URL. */
  url?: string;
  /** Auth adapter — handles session resolution internally. */
  auth?: AuthClientAdapter;
  version?: string;
  transport?: ClientConfig["transport"];
  children: React.ReactNode;
  onReady?: (client: ParcaeClient) => void;
  onError?: (error: Error) => void;
}

export const ParcaeProvider: React.FC<ParcaeProviderProps> = ({
  client: externalClient,
  url,
  auth,
  version = "v1",
  transport = "socket",
  children,
  onReady,
  onError,
}) => {
  const client = useMemo(() => {
    if (externalClient) return externalClient;
    if (!url)
      throw new Error(
        "ParcaeProvider requires either a `client` or `url` prop",
      );
    // When an auth adapter is supplied, pre-thread its `getToken`
    // into the transport so the auth handshake can fire as soon as
    // the socket connects (in parallel with React mount), instead
    // of waiting for this Provider's useEffect to run AFTER every
    // child effect (DOL-1037). Falls back to the legacy
    // useEffect-driven `client.authenticate(token)` flow when no
    // adapter is supplied or for downstream-only token rotation.
    const eagerGetToken = auth
      ? async () => {
          try {
            // Initialise the adapter if the consumer didn't pass a
            // pre-initialised one. `betterAuth({ baseUrl })` already
            // primed `getSession` at module-eval; this is a cheap
            // idempotent guard for the lazy-init case.
            auth.init(url);
            return await auth.getToken();
          } catch {
            return null;
          }
        }
      : undefined;
    return createClient({ url, version, transport, getToken: eagerGetToken });
  }, [externalClient, url, version, transport, auth]);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Initialize auth adapter and resolve session
  useEffect(() => {
    if (!auth) {
      // No auth adapter — resolve as unauthenticated immediately
      client.authenticate(null).catch(() => {});
      return;
    }

    // Init adapter with the backend URL (idempotent — the eager
    // `getToken` factory above may have already called this).
    auth.init(url || "");

    // The initial auth handshake is driven by the transport's
    // constructor-supplied `getToken` (passed via `createClient`
    // above). We deliberately do NOT call `client.authenticate(token)`
    // here on first mount — doing so would race the eager handshake
    // and cause the AuthGate to resolve twice (the v=1 / v=2 double-
    // resolve we saw earlier in the DOL-1037 trace). The
    // `onReady` callback is still surfaced; we fire it once the gate
    // settles (whether authenticated or unauthenticated).

    // Belt-and-suspenders cache eviction on user transitions
    // (DOL-1037 prefetch safety). When userId changes — sign-out to
    // null, or sign-in as a new user — drop every `useQuery` cache
    // entry that was keyed under the prior userId. Without this,
    // entries linger for the 60s GC window after the session ends.
    // Not a security issue (the keys differ across users so the
    // stale data isn't reachable from the new session) but cleans
    // up memory promptly and shortens the privacy window.
    const transport: any = client.transport;
    let lastUserId: string | null =
      transport?.auth?.state?.userId ?? null;

    // One-shot onReady — fires the first time the gate leaves
    // "pending". The transport's eager handshake settles the gate
    // independently of this effect's scheduling.
    let readyFired = false;
    const fireReady = () => {
      if (readyFired) return;
      if (transport?.auth?.state?.status === "pending") return;
      readyFired = true;
      try {
        onReadyRef.current?.(client);
      } catch (err: any) {
        log.warn("onReady threw:", err?.message);
      }
    };

    const unsubGate: undefined | (() => void) =
      transport?.auth?.subscribe?.(() => {
        const nowUserId: string | null =
          transport?.auth?.state?.userId ?? null;
        if (lastUserId !== null && nowUserId !== lastUserId) {
          _purgeCacheForUser(lastUserId);
        }
        lastUserId = nowUserId;
        fireReady();
      });
    // If the transport's eager handshake already settled before this
    // effect ran (very likely on cold start), fire onReady right away.
    fireReady();

    // Subscribe to session changes (login/logout). Token rotation
    // still flows through the explicit `client.authenticate(token)`
    // path — that's the only place the AuthGate gets a *new* token
    // after the initial handshake, so there's no race.
    const unsub = auth.onChange((token) => {
      client.authenticate(token).catch(() => {});
    });

    return () => {
      unsub();
      unsubGate?.();
    };
  }, [auth, client, url]);

  // On socket reconnect, re-resolve session via auth adapter
  useEffect(() => {
    if (!auth) return;

    const onReconnect = async () => {
      log.debug("reconnected — re-resolving session");
      try {
        const token = await auth.getToken();
        await client.authenticate(token);
      } catch {
        await client.authenticate(null);
      }
    };

    client.on("connected", onReconnect);
    return () => {
      client.off("connected", onReconnect);
    };
  }, [auth, client]);

  // Forward errors
  useEffect(() => {
    const onErr = (err: Error) => onErrorRef.current?.(err);
    client.on("error", onErr);
    return () => {
      client.off("error", onErr);
    };
  }, [client]);

  return (
    <ParcaeContext.Provider value={client}>{children}</ParcaeContext.Provider>
  );
};
