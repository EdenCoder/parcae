"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { createClient } from "../client";
import type { ParcaeClient, ClientConfig } from "../client";
import { ParcaeContext } from "./context";

export interface ParcaeProviderProps {
  client?: ParcaeClient;
  url?: string;
  /** undefined = auth loading, null = no session, string = token */
  apiKey?: string | null | undefined;
  userId?: string | null;
  version?: string;
  transport?: ClientConfig["transport"];
  children: React.ReactNode;
  onReady?: (client: ParcaeClient) => void;
  onError?: (error: Error) => void;
}

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
  const client = useMemo(() => {
    if (externalClient) return externalClient;
    if (!url)
      throw new Error(
        "ParcaeProvider requires either a `client` or `url` prop",
      );
    return createClient({ url, version, transport, token: apiKey });
  }, [externalClient, url, version, transport]);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // When apiKey changes, re-authenticate
  useEffect(() => {
    if (apiKey === undefined) return;
    client
      .authenticate(apiKey)
      .then(() => {
        onReadyRef.current?.(client);
      })
      .catch((err: Error) => {
        onErrorRef.current?.(err);
      });
  }, [apiKey, userId, client]);

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
