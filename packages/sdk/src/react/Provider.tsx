"use client";

import React, { useEffect, useRef, useState } from "react";
import { createClient } from "../client";
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
   * Pass a stable (module-level) reference: a fresh object per
   * render creates a fresh client.
   */
  extraHeaders?: Record<string, string>;
  children: React.ReactNode;
  onReady?: (client: ParcaeClient) => void;
  onError?: (error: Error) => void;
}

const noopToken = async () => null;
const readyClients = new WeakSet<ParcaeClient>();

interface ClientProviderProps extends ParcaeProviderProps {
  client: ParcaeClient;
}

const ClientProvider: React.FC<ClientProviderProps> = ({
  client,
  url,
  auth,
  children,
  onReady,
  onError,
}) => {
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // ── Session lifecycle ───────────────────────────────────────────
  useEffect(() => {
    let lastUserId: string | null = client.session.state.userId;
    let lastStatus = client.session.state.status;

    // Fire onReady the first time the session leaves "pending".
    const fireReady = () => {
      if (readyClients.has(client)) return;
      if (client.session.state.status === "pending") return;
      const onClientReady = onReadyRef.current;
      if (!onClientReady) return;
      readyClients.add(client);
      try {
        onClientReady(client);
      } catch (err: any) {
        log.warn("onReady threw:", err?.message);
      }
    };

    const unsubSession = client.session.subscribe(() => {
      const nowUserId = client.session.state.userId;
      const nowStatus = client.session.state.status;
      if (
        lastStatus !== "pending" &&
        (nowUserId !== lastUserId || nowStatus !== lastStatus)
      ) {
        _purgeCacheForUser(client, lastUserId);
      }
      lastUserId = nowUserId;
      lastStatus = nowStatus;
      fireReady();
    });
    fireReady();

    return () => {
      unsubSession();
    };
  }, [client]);

  // ── Optional auth adapter ────────────────────────────────────────
  useEffect(() => {
    if (!auth) return;
    auth.init(url || "");
    return auth.onChange((token) => {
      if (token === null) {
        client.terminateSession().catch(() => {});
      } else {
        client.refreshSession().catch(() => {});
      }
    });
  }, [auth, client, url]);

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

const OwnedProvider: React.FC<Omit<ParcaeProviderProps, "client">> = ({
  url,
  auth,
  version = "v1",
  transports,
  extraHeaders,
  ...props
}) => {
  const [client, setClient] = useState<ParcaeClient | null>(null);

  useEffect(() => {
    if (!url) return;
    const getToken: ClientConfig["getToken"] = auth
      ? async () => {
          auth.init(url);
          return await auth.getToken();
        }
      : noopToken;
    const owned = createClient({
      url,
      version,
      getToken,
      transports,
      extraHeaders,
    });
    setClient(owned);
    return () => owned.dispose();
  }, [url, version, auth, transports, extraHeaders]);

  if (!client) return null;
  return <ClientProvider {...props} url={url} auth={auth} client={client} />;
};

export const ParcaeProvider: React.FC<ParcaeProviderProps> = (props) => {
  if (props.client) return <ClientProvider {...props} client={props.client} />;
  if (!props.url) {
    throw new Error(
      "ParcaeProvider requires either a `client` or `url` prop",
    );
  }
  return <OwnedProvider {...props} />;
};
