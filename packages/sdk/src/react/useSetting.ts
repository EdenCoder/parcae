"use client";

/**
 * useSetting — key-value user settings stored as a Setting model.
 *
 * @example
 * ```tsx
 * const [theme, setTheme, { isLoading }] = useSetting("theme", "light");
 * ```
 */

import { useState, useEffect, useCallback } from "react";
import { useParcae } from "./context";

export function useSetting<T = string>(
  key: string,
  defaultValue: T,
): [T, (value: T) => Promise<void>, { isLoading: boolean }] {
  const client = useParcae();
  const [value, setValue] = useState<T>(defaultValue);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    client
      .get(`/settings/${encodeURIComponent(key)}`)
      .then((result) => {
        if (!cancelled && result?.value !== undefined) {
          setValue(result.value);
        }
      })
      .catch(() => {
        // Setting doesn't exist yet — use default
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [key, client]);

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
