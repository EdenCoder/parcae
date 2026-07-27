"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { _getOrCreateProviderClient } from "../client";
import type { ParcaeClient, ClientConfig } from "../client";
import type { AuthClientAdapter } from "../auth-adapter";
import { ParcaeContext } from "./context";
import { _onResyncRequired, _purgeCacheForUser } from "./useQuery";
import { log } from "../log";

export interface ParcaeProviderProps {
  /** Pre-created client instance. */
  client?: ParcaeClient;
  /** Backend URL. */
  url?: string;
  /** Auth adapter — handles session resolution internally. */
  auth?: AuthClientAdapter;
  version?: string;
  /**
   * socket.io transports list. Defaults to `["websocket"]`. Pass
   * `["polling"]` on runtimes without a WebSocket global.
   */
  transports?: ("websocket" | "polling")[];
  /**
   * Extra headers attached to the socket handshake. Applied in Node
   * and React Native; browsers ignore them for WebSocket transport.
   * Pass a stable (module-level) reference to avoid unnecessary memo work.
   * Cached clients fail closed if transports or header values differ.
   */
  extraHeaders?: Record<string, string>;
  children: React.ReactNode;
  onReady?: (client: ParcaeClient) => void;
  onError?: (error: Error) => void;
}

const noopToken = async () => null;

interface CommittedProviderProps extends ParcaeProviderProps {
  committedClient: ParcaeClient;
  committedGetToken: ClientConfig["getToken"];
}

/**
 * Resolve an internal client only after React commits this Provider. A render
 * that suspends, throws, or is abandoned must not open a socket, install the
 * global model adapter, retain an auth resolver, or populate the client cache.
 */
export const ParcaeProvider: React.FC<ParcaeProviderProps> = (props) => {
  const {
    client: externalClient,
    url,
    auth,
    version = "v1",
    transports,
    extraHeaders,
  } = props;
  if (!externalClient && !url) {
    throw new Error("ParcaeProvider requires either a `client` or `url` prop");
  }

  const getToken = useMemo<ClientConfig["getToken"]>(() => {
    if (!auth) return noopToken;
    return async () => {
      auth.init(url || "");
      return await auth.getToken();
    };
  }, [auth, url]);

  const internalConfig = useMemo<ClientConfig | null>(
    () =>
      externalClient || !url
        ? null
        : {
            url,
            version,
            getToken,
            transports,
            extraHeaders,
          },
    [externalClient, extraHeaders, getToken, transports, url, version],
  );
  const [committedInternal, setCommittedInternal] = useState<{
    config: ClientConfig;
    client: ParcaeClient;
  } | null>(null);

  useLayoutEffect(() => {
    if (!internalConfig) {
      setCommittedInternal(null);
      return;
    }

    // The client is born anonymous. The committed inner Provider acquires the
    // resolver lease and installs the real auth source in its own layout effect.
    const created = _getOrCreateProviderClient({
      ...internalConfig,
      getToken: noopToken,
    });
    setCommittedInternal({ config: internalConfig, client: created });

    return () => {
      // If React unmounts before the committed inner Provider acquires the
      // lease, close the anonymous socket created by this committed effect.
      if (!created.hasTokenResolverLease) created.disconnect();
    };
  }, [internalConfig]);

  const committedClient =
    externalClient ??
    (committedInternal?.config === internalConfig
      ? committedInternal.client
      : null);
  if (!committedClient) return null;

  return (
    <CommittedParcaeProvider
      {...props}
      committedClient={committedClient}
      committedGetToken={getToken}
    />
  );
};

const CommittedParcaeProvider: React.FC<CommittedProviderProps> = ({
  committedClient: client,
  committedGetToken: getToken,
  client: externalClient,
  url,
  auth,
  version = "v1",
  transports,
  extraHeaders,
  children,
  onReady,
  onError,
}) => {
  const providerControlsResolver = !externalClient || auth !== undefined;
  const committedExternalAuthRef = useRef<{
    client: ParcaeClient;
    hadAuth: boolean;
  } | null>(null);
  if (
    externalClient &&
    auth === undefined &&
    committedExternalAuthRef.current?.client === client &&
    committedExternalAuthRef.current.hadAuth
  ) {
    throw new Error(
      "ParcaeProvider cannot remove `auth` from the same external client; replace the client or unmount first",
    );
  }
  if (
    providerControlsResolver &&
    (typeof client.acquireTokenResolverLease !== "function" ||
      typeof client.releaseTokenResolverLease !== "function")
  ) {
    throw new Error(
      "ParcaeProvider cannot bind auth unless the client supports auth reconciliation",
    );
  }

  const resolverLeaseRef = useRef<object>({});
  const providerMountedRef = useRef(false);

  // Resolver ownership is mutable shared state. Bind it only after React
  // commits this Provider; a speculative or aborted render must not change the
  // auth source used by the still-committed tree.
  useLayoutEffect(() => {
    const lease = resolverLeaseRef.current;
    providerMountedRef.current = true;
    if (providerControlsResolver) {
      client.acquireTokenResolverLease!(lease, getToken);
    }
    committedExternalAuthRef.current = externalClient
      ? { client, hadAuth: auth !== undefined }
      : null;

    return () => {
      providerMountedRef.current = false;
      if (providerControlsResolver) {
        const released = client.releaseTokenResolverLease!(lease);
        if (released) {
          const userId = client.session.state.userId;
          _purgeCacheForUser(client, userId);
          const termination = client.terminateSession();
          // Closing the physical socket guarantees the server cannot retain an
          // authenticated session if the terminating hello or its ack is lost.
          client.disconnect();
          void termination.catch(() => {
            log.warn("Provider cleanup could not terminate its session");
          });
        }
      }
      if (committedExternalAuthRef.current?.client === client) {
        committedExternalAuthRef.current = null;
      }
    };
  }, [auth, client, externalClient, getToken, providerControlsResolver]);

  const [readyPair, setReadyPair] = useState<{
    auth: AuthClientAdapter | undefined;
    client: ParcaeClient;
  } | null>(null);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const activeReconciliationRef = useRef<{
    client: ParcaeClient;
    generation: number;
    emittedErrors: WeakSet<Error>;
  } | null>(null);
  const reportError = useCallback((error: unknown) => {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    try {
      onErrorRef.current?.(normalized);
    } catch {
      log.warn("Provider onError callback failed");
    }
  }, []);

  // ── Session lifecycle ───────────────────────────────────────────
  useEffect(() => {
    auth?.init(url || "");

    let active = true;
    let transitionGeneration = 0;
    let lastUserId: string | null = client.session.state.userId;
    let observedSessionBoundary = false;

    let readyFired = false;
    const fireReady = () => {
      if (readyFired) return;
      readyFired = true;
      try {
        onReadyRef.current?.(client);
      } catch {
        log.warn("Provider onReady callback failed");
      }
    };

    const reconcile = (operation: () => Promise<unknown>): void => {
      const generation = ++transitionGeneration;
      const currentUserId = client.session.state.userId;
      _purgeCacheForUser(client, currentUserId);
      const reconciliation = {
        client,
        generation,
        emittedErrors: new WeakSet<Error>(),
      };
      activeReconciliationRef.current = reconciliation;
      setReadyPair((current) =>
        current && current.auth === auth && current.client === client
          ? null
          : current,
      );

      void operation()
        .then(() => {
          if (!active || generation !== transitionGeneration) return;
          if (activeReconciliationRef.current === reconciliation) {
            activeReconciliationRef.current = null;
          }
          if (client.session.state.status === "terminated") {
            setReadyPair(null);
            return;
          }
          setReadyPair({ auth, client });
          fireReady();
        })
        .catch((error: unknown) => {
          if (!active || generation !== transitionGeneration) return;
          if (activeReconciliationRef.current === reconciliation) {
            activeReconciliationRef.current = null;
          }
          if (
            error instanceof Error &&
            reconciliation.emittedErrors.has(error)
          ) {
            return;
          }
          reportError(error);
        });
    };

    const unsubSession = client.session.subscribe(() => {
      if (!providerMountedRef.current) return;
      const previousUserId = lastUserId;
      const nowUserId = client.session.state.userId;
      const nowStatus = client.session.state.status;
      const expectedTransition =
        activeReconciliationRef.current?.client === client;

      if (nowStatus === "pending") {
        observedSessionBoundary = true;
        _purgeCacheForUser(client, previousUserId);
        setReadyPair(null);
        return;
      }

      if (nowUserId !== previousUserId) {
        _purgeCacheForUser(client, previousUserId);
      }
      lastUserId = nowUserId;

      if (nowStatus === "terminated") {
        observedSessionBoundary = false;
        setReadyPair(null);
        return;
      }

      if (observedSessionBoundary) {
        observedSessionBoundary = false;
        setReadyPair({ auth, client });
        fireReady();
        return;
      }

      // A shared client must never change identity behind an open Provider.
      // Re-close immediately and confirm the Provider-owned resolver before
      // exposing children again.
      if (nowUserId !== previousUserId && !expectedTransition) {
        reconcile(() => client.refreshSession());
      }
    });

    reconcile(async () => {
      if (externalClient && auth) {
        await client.refreshSession();
      } else if (client.needsSessionRefresh) {
        await client.refreshSession();
      } else {
        await client.session.ready;
      }
    });

    // Token rotation / login / logout from the adapter. Each transition
    // closes the context until the server has confirmed the new identity.
    const unsubChange =
      auth?.onChange((token) => {
        reconcile(() =>
          token === null ? client.terminateSession() : client.refreshSession(),
        );
      }) ?? (() => undefined);

    return () => {
      active = false;
      transitionGeneration++;
      if (activeReconciliationRef.current?.client === client) {
        activeReconciliationRef.current = null;
      }
      unsubSession();
      unsubChange();
    };
  }, [auth, client, externalClient, reportError, url]);

  // ── Resync on reconnect ─────────────────────────────────────────
  useEffect(() => {
    const onResync = () => _onResyncRequired(client);
    client.on("resync-required", onResync);
    return () => {
      client.off("resync-required", onResync);
    };
  }, [client]);

  // ── Error forwarding ────────────────────────────────────────────
  useEffect(() => {
    const onErr = (err: Error) => {
      const activeReconciliation = activeReconciliationRef.current;
      if (activeReconciliation?.client === client) {
        activeReconciliation.emittedErrors.add(err);
      }
      reportError(err);
    };
    client.on("error", onErr);
    return () => {
      client.off("error", onErr);
    };
  }, [client, reportError]);

  const ready =
    readyPair !== null &&
    readyPair.auth === auth &&
    readyPair.client === client;

  return ready ? (
    <ParcaeContext.Provider value={client}>{children}</ParcaeContext.Provider>
  ) : null;
};
