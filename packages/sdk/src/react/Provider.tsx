"use client";

import React, { useEffect, useMemo, useRef } from "react";
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
   * render re-runs the client memo, and the client cache would pin
   * the first-created instance anyway.
   */
  extraHeaders?: Record<string, string>;
  children: React.ReactNode;
  onReady?: (client: ParcaeClient) => void;
  onError?: (error: Error) => void;
}

const noopToken = async () => null;

export const ParcaeProvider: React.FC<ParcaeProviderProps> = ({
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
  const client = useMemo(() => {
    if (externalClient) return externalClient;
    if (!url)
      throw new Error(
        "ParcaeProvider requires either a `client` or `url` prop",
      );

    const getToken: ClientConfig["getToken"] = auth
      ? async () => {
          auth.init(url);
          return await auth.getToken();
        }
      : noopToken;

    return createClient({ url, version, getToken, transports, extraHeaders });
  }, [externalClient, url, version, auth, transports, extraHeaders]);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // ── Session lifecycle ───────────────────────────────────────────
  useEffect(() => {
    if (!auth) return;
    auth.init(url || "");

    let lastUserId: string | null = client.session.state.userId;

    // Fire onReady the first time the session leaves "pending".
    let readyFired = false;
    const fireReady = () => {
      if (readyFired) return;
      if (client.session.state.status === "pending") return;
      readyFired = true;
      try {
        onReadyRef.current?.(client);
      } catch (err: any) {
        log.warn("onReady threw:", err?.message);
      }
    };

    const unsubSession = client.session.subscribe(() => {
      const nowUserId = client.session.state.userId;
      if (lastUserId !== null && nowUserId !== lastUserId) {
        _purgeCacheForUser(lastUserId);
      }
      lastUserId = nowUserId;
      fireReady();
    });
    fireReady();

    // Token rotation / login / logout from the adapter.
    const unsubChange = auth.onChange((token) => {
      if (token === null) {
        client.terminateSession().catch(() => {});
      } else {
        client.refreshSession().catch(() => {});
      }
    });

    return () => {
      unsubSession();
      unsubChange();
    };
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
