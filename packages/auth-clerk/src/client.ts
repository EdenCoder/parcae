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
 *   const auth = useMemo(() => createClerkAuthAdapter(getToken), [getToken]);
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
}

/**
 * Create a client-side Clerk auth adapter.
 *
 * Pass `getToken` from Clerk's `useAuth()` hook (or an equivalent async
 * function for background contexts). The adapter satisfies Parcae's
 * `AuthClientAdapter` and can be handed straight to `<ParcaeProvider auth={…}>`.
 */

/** WeakMap to associate adapters with their internal listener sets. */
const adapterListeners = new WeakMap<
  AuthClientAdapter,
  Set<TokenChangeCallback>
>();

export function createClerkAuthAdapter(
  getToken: GetTokenFn,
  options: ClerkClientAdapterOptions = {},
): AuthClientAdapter {
  const listeners = new Set<TokenChangeCallback>();

  const adapter: AuthClientAdapter = {
    init() {
      // No initialization needed — Clerk manages sessions externally.
    },

    async getToken() {
      try {
        const token = await getToken({
          organizationId: options.organizationId ?? undefined,
        });
        return token ?? null;
      } catch {
        return null;
      }
    },

    onChange(callback: TokenChangeCallback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };

  adapterListeners.set(adapter, listeners);
  return adapter;
}

/**
 * Notify all `onChange` subscribers that the session changed.
 * Useful when Clerk fires a sign-out or token refresh outside React.
 */
export function notifyClerkTokenChange(
  adapter: AuthClientAdapter,
  token: string | null,
) {
  const listeners = adapterListeners.get(adapter);

  if (listeners) {
    for (const cb of listeners) {
      cb(token);
    }
  }
}
