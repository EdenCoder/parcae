"use client";

import { useState, useEffect, useCallback } from "react";
import { useSnapshot } from "valtio";
import { useParcae } from "./context";

export function useSetting<T = string>(
  key: string,
  defaultValue: T,
): [T, (value: T) => Promise<void>, { isLoading: boolean }] {
  const client = useParcae();
  const transport = client.transport as any;
  const authState = transport?.auth?.state;
  const snap = authState ? useSnapshot(authState) : null;
  const authStatus = (snap as any)?.status ?? "pending";

  const [value, setValue] = useState<T>(defaultValue);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (authStatus === "pending") return;
    if (authStatus === "unauthenticated") {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    client
      .get(`/settings/${encodeURIComponent(key)}`)
      .then((result: any) => {
        if (!cancelled && result?.value !== undefined) setValue(result.value);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [key, client, authStatus]);

  const update = useCallback(
    async (newValue: T) => {
      setValue(newValue);
      await client.put(`/settings/${encodeURIComponent(key)}`, {
        value: newValue,
      });
    },
    [key, client],
  );

  return [value, update, { isLoading }];
}
