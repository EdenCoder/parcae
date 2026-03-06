"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "../client";
import type { ParcaeClient, ClientConfig } from "../client";
import { ParcaeContext } from "./context";
import type { AuthState } from "./context";

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
  const [authState, setAuthState] = useState<AuthState>(
    apiKey === undefined
      ? "loading"
      : apiKey === null
        ? "unauthenticated"
        : "loading",
  );
  const [authVersion, setAuthVersion] = useState(0);

  const client = useMemo(() => {
    if (externalClient) return externalClient;
    if (!url)
      throw new Error(
        "ParcaeProvider requires either a `client` prop or a `url` prop",
      );
    return createClient({ url, version, transport });
  }, [externalClient, url, version, transport]);

  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Authenticate when apiKey changes
  useEffect(() => {
    if (apiKey === undefined) {
      setAuthState("loading");
      return;
    }

    setAuthState("loading");
    client
      .authenticate(apiKey)
      .then(({ userId: uid }) => {
        setAuthState(uid ? "authenticated" : "unauthenticated");
        setAuthVersion((v) => v + 1);
        onReadyRef.current?.(client);
      })
      .catch((err: Error) => {
        setAuthState("unauthenticated");
        setAuthVersion((v) => v + 1);
        onErrorRef.current?.(err);
      });
  }, [apiKey, userId, client]);

  // Re-authenticate on reconnect
  useEffect(() => {
    const onReconnect = () => {
      const key = apiKeyRef.current;
      if (key === undefined) return;

      setAuthState("loading");
      client
        .authenticate(key)
        .then(({ userId: uid }) => {
          setAuthState(uid ? "authenticated" : "unauthenticated");
          setAuthVersion((v) => v + 1);
        })
        .catch(() => {
          setAuthState("unauthenticated");
          setAuthVersion((v) => v + 1);
        });
    };

    client.on("reconnected", onReconnect);
    return () => {
      client.off("reconnected", onReconnect);
    };
  }, [client]);

  // Forward errors
  useEffect(() => {
    const onErr = (err: Error) => onErrorRef.current?.(err);
    client.on("error", onErr);
    return () => {
      client.off("error", onErr);
    };
  }, [client]);

  const contextValue = useMemo(
    () => ({ client, authState, authVersion }),
    [client, authState, authVersion],
  );

  return (
    <ParcaeContext.Provider value={contextValue}>
      {children}
    </ParcaeContext.Provider>
  );
};

export default ParcaeProvider;
