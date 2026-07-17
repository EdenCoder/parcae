"use client";

import React, { useEffect, useRef, useState } from "react";
import { Model } from "@parcae/model";
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
   * Bind this client's adapter as the default for every Model class —
   * the frontend equivalent of the backend's `Model.use(adapter)` in
   * createApp(). Static factories (`Project.create(...)`, terminal
   * query methods on unbound classes) then work anywhere in the tree.
   * Default `true`.
   *
   * The first mounted provider wins; a concurrent provider with a
   * different client skips silently. Explicit `client.bind(Model)`
   * and `useQuery` chain rebinding still take precedence for
   * multi-client apps — pass `false` there to opt out entirely.
   */
  bindAdapter?: boolean;
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
  bindAdapter = true,
  children,
  onReady,
  onError,
}) => {
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // ── Default model adapter ───────────────────────────────────────
  // One global default per realm: the first provider to mount binds
  // the base Model class, which every subclass resolves through the
  // prototype walk in getBoundAdapter(). A second concurrent provider
  // finds the binding already set and leaves it alone.
  useEffect(() => {
    if (!bindAdapter || Model.hasAdapter()) return;
    Model.use(client.adapter);
  }, [bindAdapter, client]);

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
