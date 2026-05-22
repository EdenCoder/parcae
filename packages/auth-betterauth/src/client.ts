/**
 * @parcae/auth-betterauth — Client adapter
 *
 * Usage (eager, recommended — pre-fires the session HTTP at module
 * evaluation so the token is ready by the time React mounts):
 *
 * ```tsx
 * import { betterAuth } from "@parcae/auth-betterauth/client";
 *
 * const auth = betterAuth({ baseUrl: process.env.NEXT_PUBLIC_API_URL });
 *
 * <ParcaeProvider url={baseUrl} auth={auth}>
 * ```
 *
 * Usage (lazy — ParcaeProvider calls `init()` from its useEffect):
 *
 * ```tsx
 * const auth = betterAuth();
 *
 * <ParcaeProvider url="..." auth={auth}>
 * ```
 *
 * The eager form saves the round-trip-from-Provider-effect-to-server
 * handshake (typically 40–80ms on a cold start, depending on whether
 * `/v1/auth/get-session` is hot in the backend). The lazy form is
 * backward-compatible — no change required for existing callers.
 */

import { createAuthClient } from "better-auth/react";

interface AuthClientAdapter {
  init(baseUrl: string): void;
  getToken(): Promise<string | null>;
  onChange(callback: (token: string | null) => void): () => void;
}

export interface BetterAuthOptions {
  /**
   * Backend base URL. When provided, the adapter calls `init()`
   * immediately and fires the first `getSession()` request from
   * module evaluation — typically before React renders the Provider.
   * The pending session Promise is cached and consumed by the first
   * `getToken()` call, avoiding a separate round trip later.
   *
   * Omit to defer initialisation until `ParcaeProvider` calls `init()`.
   */
  baseUrl?: string;
}

export function betterAuth(opts: BetterAuthOptions = {}): AuthClientAdapter {
  let client: ReturnType<typeof createAuthClient> | null = null;
  // Cache for the pending session request when `baseUrl` is provided
  // eagerly. The first `getToken()` consumes it and clears the slot
  // so subsequent calls re-fetch (covers token rotation). Typed as
  // `any` because better-auth's `getSession()` return type is
  // overload-shaped and the tsup DTS pass struggles to narrow it
  // through `NonNullable<typeof client>` — the wire shape is what
  // matters here, not the static type.
  let primedSessionPromise: Promise<any> | null = null;

  const initInternal = (baseUrl: string): void => {
    if (client) return;
    client = createAuthClient({
      baseURL: baseUrl,
      basePath: "/v1/auth",
    });
  };

  // Eager init — pre-fire the session HTTP at module evaluation so
  // the token is ready (or close to it) by the time React mounts.
  if (opts.baseUrl) {
    initInternal(opts.baseUrl);
    primedSessionPromise = client!.getSession();
  }

  return {
    init(baseUrl: string) {
      // Idempotent — eager init already ran if `baseUrl` was provided
      // to the factory.
      initInternal(baseUrl);
    },

    async getToken(): Promise<string | null> {
      if (!client) return null;
      try {
        const primed = primedSessionPromise;
        primedSessionPromise = null; // one-shot
        const session = await (primed ?? client.getSession());
        return session?.data?.session?.token ?? null;
      } catch {
        return null;
      }
    },

    onChange(callback: (token: string | null) => void): () => void {
      // Better Auth doesn't have a native onChange — poll on visibility change
      const handler = async () => {
        if (document.visibilityState === "visible" && client) {
          try {
            const session = await client.getSession();
            const token = session?.data?.session?.token ?? null;
            callback(token);
          } catch {
            callback(null);
          }
        }
      };
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", handler);
      }
      return () => {
        if (typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", handler);
        }
      };
    },
  };
}
