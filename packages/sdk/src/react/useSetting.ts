"use client";

import { useState, useEffect, useCallback } from "react";
import { useParcae } from "./context";
import { useAuthStatus } from "./useAuth";

export function useSetting<T = string>(
  key: string,
  defaultValue: T,
): [T, (value: T) => Promise<void>, { isLoading: boolean }] {
  const client = useParcae();
  const { status: authStatus } = useAuthStatus();

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
