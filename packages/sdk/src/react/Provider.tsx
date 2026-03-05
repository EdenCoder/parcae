"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { createClient } from "../client";
import type { ParcaeClient, ClientConfig } from "../client";
import { ParcaeContext } from "./context";

export interface ParcaeProviderProps {
  /** Pre-created client instance. If provided, url/key/transport are ignored. */
  client?: ParcaeClient;
  /** API base URL (required if no client provided). */
  url?: string;
  /** Bearer token or null (pre-auth). */
  apiKey?: string | null;
  /** Stable user ID — triggers re-auth when it changes. */
  userId?: string | null;
  /** API version. Default: "v1" */
  version?: string;
  /** Transport type. Default: "socket" */
  transport?: ClientConfig["transport"];
  children: React.ReactNode;
  onReady?: (client: ParcaeClient) => void;
  onError?: (error: Error) => void;
}

/**
 * ParcaeProvider — creates the SDK client once and re-authenticates on userId change.
 *
 * Usage with pre-created client:
 * ```tsx
 * const client = createClient({ url: "...", transport: "socket" });
 * <ParcaeProvider client={client}><App /></ParcaeProvider>
 * ```
 *
 * Usage with inline config:
 * ```tsx
 * <ParcaeProvider url="http://localhost:3000" apiKey={token} userId={user.id}>
 *   <App />
 * </ParcaeProvider>
 * ```
 */
export const ParcaeProvider: React.FC<ParcaeProviderProps> = ({
  client: externalClient,
  url,
  apiKey,
  userId,
  version = "v1",
  transport = "socket",
  children,
  onReady,
  onError,
}) => {
  // Create client once per url+version+transport (or use external)
  const client = useMemo(() => {
    if (externalClient) return externalClient;
    if (!url)
      throw new Error(
        "ParcaeProvider requires either a `client` prop or a `url` prop",
      );
    return createClient({ url, version, transport, key: null });
  }, [externalClient, url, version, transport]);

  // Refs for callbacks to avoid re-running effects on unstable inline functions
  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Re-authenticate when userId changes
  useEffect(() => {
    client
      .setKey(apiKeyRef.current ?? null)
      .then(() => onReadyRef.current?.(client))
      .catch((err) => onErrorRef.current?.(err));
  }, [userId, client]);

  // Forward transport errors
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

export default ParcaeProvider;
