import { createContext, useContext } from "react";
import type { ParcaeClient } from "../client";

export const ParcaeContext = createContext<ParcaeClient | null>(null);

export function useParcae(): ParcaeClient {
  const client = useContext(ParcaeContext);
  if (!client)
    throw new Error("useParcae must be used within a <ParcaeProvider>");
  return client;
}
