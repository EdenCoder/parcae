/**
 * @parcae/sdk/react
 *
 * React integration for Parcae — Provider, hooks, and realtime queries.
 */

export { ParcaeProvider } from "./Provider";
export type { ParcaeProviderProps } from "./Provider";

export { ParcaeContext, useParcae } from "./context";
export type { AuthState, ParcaeContextValue } from "./context";

export { useQuery } from "./useQuery";
export { useApi, useSDK, useConnectionStatus, useAuthState } from "./useApi";
export { useSetting } from "./useSetting";
