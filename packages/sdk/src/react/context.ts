import { createContext, useContext } from "react";
import type { ParcaeClient } from "../client";

export type AuthState = "loading" | "authenticated" | "unauthenticated";

export interface ParcaeContextValue {
  client: ParcaeClient;
  authState: AuthState;
  authVersion: number;
}

export const ParcaeContext = createContext<ParcaeContextValue | null>(null);

export function useParcae(): ParcaeContextValue {
  const ctx = useContext(ParcaeContext);
  if (!ctx) {
    throw new Error("useParcae must be used within a <ParcaeProvider>");
  }
  return ctx;
}
