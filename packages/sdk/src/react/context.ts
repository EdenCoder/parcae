import { createContext, useContext } from "react";
import type { ParcaeClient } from "../client";

// Use globalThis to ensure all copies of @parcae/sdk share the same context
// (pnpm can install multiple copies — they all need the same React context)
const KEY = "__parcae_context";
if (!(globalThis as any)[KEY]) {
  (globalThis as any)[KEY] = createContext<ParcaeClient | null>(null);
}

export const ParcaeContext: React.Context<ParcaeClient | null> = (
  globalThis as any
)[KEY];

export function useParcae(): ParcaeClient {
  const client = useContext(ParcaeContext);
  if (!client)
    throw new Error("useParcae must be used within a <ParcaeProvider>");
  return client;
}
