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
import type { AuthClientAdapter } from "@parcae/sdk";

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

  /**
   * Pre-constructed Better Auth client. Pass this when your app already
   * holds a singleton `createAuthClient()` instance (e.g. for direct
   * sign-in/sign-out UI calls) so the adapter shares the *same* client.
   *
   * Sharing is critical: every `createAuthClient()` call creates its
   * own `$sessionSignal` nanostore atom. If the UI calls `signOut()`
   * on one client and the adapter listens for `$sessionSignal` on a
   * different client, the adapter never sees the change and Parcae's
   * session machine stays stuck.
   *
   * When `client` is provided, `baseUrl` is ignored (the client already
   * has its own base URL configured).
   */
  client?: ReturnType<typeof createAuthClient>;
}

export function betterAuth(opts: BetterAuthOptions = {}): AuthClientAdapter {
  let client: ReturnType<typeof createAuthClient> | null = opts.client ?? null;
  // Cache for the pending session request when `baseUrl` (or `client`)
  // is provided eagerly. The first `getToken()` consumes it and clears
  // the slot so subsequent calls re-fetch (covers token rotation).
  // Typed as `any` because better-auth's `getSession()` return type is
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
  // Triggers when EITHER an external client was passed OR a baseUrl
  // was given. With an external client, `initInternal()` is a no-op.
  if (opts.client) {
    primedSessionPromise = opts.client.getSession();
  } else if (opts.baseUrl) {
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
      const primed = primedSessionPromise;
      primedSessionPromise = null; // one-shot
      const session = await (primed ?? client.getSession());
      return session?.data?.session?.token ?? null;
    },

    onChange(callback: (token: string | null) => void): () => void {
      // Better Auth bumps its internal `$sessionSignal` nanostore atom on:
      //   /sign-in/email, /sign-up/email, /sign-out, /revoke-session(s),
      //   /update-user, /update-session, /verify-email, /change-email,
      //   /delete-user
      //
      // Subscribing to that atom lets us react synchronously to in-tab
      // auth changes — sign-out shows protected gates immediately,
      // sign-in lifts them without a page reload.
      //
      // We additionally listen on `visibilitychange` to cover sessions
      // mutated outside this tab (another tab signed out and the
      // BroadcastChannel didn't reach us, or the cookie was revoked by
      // the server). Visibility polling remains the only portable
      // cross-tab path without extra infrastructure.

      let lastToken: string | null | undefined = undefined;
      let active = true;
      let generation = 0;

      const readAndNotify = async () => {
        if (!client) return;
        const currentGeneration = ++generation;
        try {
          const session = await client.getSession();
          if (!active || currentGeneration !== generation) return;
          const token = session?.data?.session?.token ?? null;
          if (token === lastToken) return;
          lastToken = token;
          callback(token);
        } catch {
          // Transient auth endpoint failures are not sign-outs.
          // Keep the current session identity until a successful
          // session read proves it changed.
        }
      };

      // Reactive path: better-auth's session signal atom. The proxy
      // bumps it (with a 10ms setTimeout) after every auth-mutating
      // request resolves successfully.
      //
      // Nanostores' `listen(fn)` (vs `subscribe(fn)`) does NOT fire on
      // attach — only on subsequent changes, which is what we want.
      let unsubscribeSignal: (() => void) | null = null;
      const c = client as unknown as
        | {
            $store?: {
              atoms?: Record<
                string,
                { listen?: (l: () => void) => () => void }
              >;
            };
          }
        | null;
      const atom = c?.$store?.atoms?.$sessionSignal;
      if (atom?.listen) {
        unsubscribeSignal = atom.listen(() => {
          void readAndNotify();
        });
      }

      // Visibility fallback (cross-tab / external mutations).
      const visibilityHandler = () => {
        if (typeof document === "undefined") return;
        if (document.visibilityState !== "visible") return;
        void readAndNotify();
      };
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", visibilityHandler);
      }

      return () => {
        active = false;
        generation++;
        unsubscribeSignal?.();
        if (typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", visibilityHandler);
        }
      };
    },
  };
}
