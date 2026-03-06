"use client";

import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { createClient } from "../client";
import type { ParcaeClient, ClientConfig } from "../client";
import { ParcaeContext } from "./context";
import type { ParcaeContextValue, AuthState } from "./context";

export interface ParcaeProviderProps {
  /** Pre-created client instance. If provided, url/key/transport are ignored. */
  client?: ParcaeClient;
  /** API base URL (required if no client provided). */
  url?: string;
  /** Bearer token, null (no session), or undefined (still loading). */
  apiKey?: string | null | undefined;
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
    // If apiKey is undefined, the frontend auth provider is still loading.
    // If apiKey is null, the user is not logged in.
    // If apiKey is a string, we have a token but haven't verified it yet.
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
    return createClient({ url, version, transport, key: null });
  }, [externalClient, url, version, transport]);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Authenticate when apiKey changes
  useEffect(() => {
    // apiKey is undefined → frontend auth still loading, do nothing
    if (apiKey === undefined) {
      setAuthState("loading");
      return;
    }

    // apiKey is null → user is not logged in
    if (apiKey === null) {
      setAuthState("unauthenticated");
      setAuthVersion((v) => v + 1);
      return;
    }

    // apiKey is a string → send to backend for verification
    setAuthState("loading");
    client
      .setKey(apiKey)
      .then(() => {
        setAuthState("authenticated");
        setAuthVersion((v) => v + 1);
        onReadyRef.current?.(client);
      })
      .catch((err) => {
        setAuthState("unauthenticated");
        setAuthVersion((v) => v + 1);
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

  const contextValue = useMemo<ParcaeContextValue>(
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
