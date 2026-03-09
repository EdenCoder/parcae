"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { createClient } from "../client";
import type { ParcaeClient, ClientConfig } from "../client";
import type { AuthClientAdapter } from "../auth-adapter";
import { ParcaeContext } from "./context";
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
    // Don't pass token — auth adapter handles it
    return createClient({ url, version, transport });
  }, [externalClient, url, version, transport]);

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

    // Init adapter with the backend URL
    auth.init(url || "");

    // Resolve session and authenticate
    const doAuth = async () => {
      try {
        const token = await auth.getToken();
        await client.authenticate(token);
        onReadyRef.current?.(client);
      } catch (err: any) {
        log.warn("auth failed:", err?.message);
        await client.authenticate(null);
        onErrorRef.current?.(err);
      }
    };

    doAuth();

    // Subscribe to session changes (login/logout)
    const unsub = auth.onChange((token) => {
      client.authenticate(token).catch(() => {});
    });

    return unsub;
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
