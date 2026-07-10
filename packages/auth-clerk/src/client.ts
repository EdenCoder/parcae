/**
 * Client-side Clerk auth adapter for Parcae SDK.
 *
 * Bridges Clerk's `getToken()` into Parcae's `AuthClientAdapter` interface.
 * Works with both `@clerk/clerk-react` (web) and `@clerk/clerk-expo` (mobile).
 *
 * @example
 * ```tsx
 * import { createClerkAuthAdapter } from "@parcae/auth-clerk/client";
 * import { ParcaeProvider } from "@parcae/sdk/react";
 * import { useAuth } from "@clerk/clerk-react";
 *
 * function App() {
 *   const { getToken } = useAuth();
 *   const auth = useMemo(() => createClerkAuthAdapter(getToken, {
 *     subscribe: clerk.addListener,
 *   }), [getToken, clerk]);
 *
 *   return (
 *     <ParcaeProvider url="..." auth={auth}>
 *       ...
 *     </ParcaeProvider>
 *   );
 * }
 * ```
 */

import type { AuthClientAdapter } from "@parcae/sdk";

type GetTokenFn = (opts?: {
  organizationId?: string;
}) => Promise<string | null>;

type TokenChangeCallback = (token: string | null) => void;

export interface ClerkClientAdapterOptions {
  /** Clerk organization ID to scope tokens. */
  organizationId?: string | null;
  /** Subscribe to Clerk session changes. Required so onChange is live. */
  subscribe: (onSessionChange: () => void) => () => void;
  /** Receives asynchronous subscription refresh failures. */
  onError?: (error: unknown) => void;
}

/**
 * Create a client-side Clerk auth adapter.
 *
 * Pass `getToken` from Clerk's `useAuth()` hook (or an equivalent async
 * function for background contexts). The adapter satisfies Parcae's
 * `AuthClientAdapter` and can be handed straight to `<ParcaeProvider auth={…}>`.
 */

export function createClerkAuthAdapter(
  getToken: GetTokenFn,
  options: ClerkClientAdapterOptions,
): AuthClientAdapter {
  const adapter: AuthClientAdapter = {
    init() {
      // No initialization needed — Clerk manages sessions externally.
    },

    async getToken() {
      const token = await getToken({
        organizationId: options.organizationId ?? undefined,
      });
      return token ?? null;
    },

    onChange(callback: TokenChangeCallback) {
      let active = true;
      let generation = 0;
      const unsubscribe = options.subscribe(() => {
        const currentGeneration = ++generation;
        void adapter.getToken().then(
          (token) => {
            if (active && currentGeneration === generation) callback(token);
          },
          (error) => {
            if (active && currentGeneration === generation) {
              options.onError?.(error);
            }
          },
        );
      });
      return () => {
        active = false;
        generation++;
        unsubscribe();
      };
    },
  };

  return adapter;
}
