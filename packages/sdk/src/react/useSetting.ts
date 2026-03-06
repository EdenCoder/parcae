"use client";

import { useState, useEffect, useCallback } from "react";
import { useParcae } from "./context";

export function useSetting<T = string>(
  key: string,
  defaultValue: T,
): [T, (value: T) => Promise<void>, { isLoading: boolean }] {
  const { client, authState } = useParcae();
  const [value, setValue] = useState<T>(defaultValue);
  const [isLoading, setIsLoading] = useState(true);

  // Wait for auth before fetching settings (they're user-scoped)
  useEffect(() => {
    if (authState === "loading") return;
    if (authState === "unauthenticated") {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    client
      .get(`/settings/${encodeURIComponent(key)}`)
      .then((result) => {
        if (!cancelled && result?.value !== undefined) {
          setValue(result.value);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [key, client, authState]);

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
