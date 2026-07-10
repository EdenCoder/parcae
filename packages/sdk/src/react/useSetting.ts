"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParcae } from "./context";
import { useSession } from "./useSession";

export function useSetting<T = string>(
  key: string,
  defaultValue: T,
): [T, (value: T) => Promise<void>, { isLoading: boolean }] {
  const client = useParcae();
  const { status, userId } = useSession();

  const [value, setValue] = useState<T>(defaultValue);
  const [isLoading, setIsLoading] = useState(true);
  const requestGeneration = useRef(0);
  const defaultValueRef = useRef(defaultValue);
  defaultValueRef.current = defaultValue;

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setValue(defaultValueRef.current);
    setIsLoading(status === "pending" || status === "authenticated");

    if (status === "pending") return;
    if (status !== "authenticated") {
      return;
    }

    client
      .get(`/settings/${encodeURIComponent(key)}`)
      .then((result: any) => {
        if (
          requestGeneration.current === generation &&
          result?.value !== undefined
        ) {
          setValue(result.value);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (requestGeneration.current === generation) setIsLoading(false);
      });
    return () => {
      if (requestGeneration.current === generation) {
        requestGeneration.current++;
      }
    };
  }, [key, client, status, userId]);

  const update = useCallback(
    async (newValue: T) => {
      setValue(newValue);
      await client.put(`/settings/${encodeURIComponent(key)}`, {
        value: newValue,
      });
    },
    [key, client, userId],
  );

  return [value, update, { isLoading }];
}
