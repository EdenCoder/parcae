/**
 * @parcae/auth-betterauth — Client adapter
 *
 * Usage (eager, recommended — starts the session read at module
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
 * Better Auth's `session` atom owns the session. Once watched it reads
 * `/get-session`, and reads it again after every auth-mutating call, on
 * focus, back online, and when another tab broadcasts a change. The
 * adapter watches it for its whole life and takes the token from it, so
 * Parcae and the app's `useSession` share one read.
 */

import { createAuthClient } from 'better-auth/react';
import type { AuthClientAdapter } from '@parcae/sdk';

type Client = ReturnType<typeof createAuthClient>;

interface Session {
  data: { session?: { token?: string | null } | null } | null;
  isPending: boolean;
}

interface SessionAtom {
  get(): Session;
  listen(listener: (value: Session) => void): () => void;
}

export interface BetterAuthOptions {
  /**
   * Backend base URL. When provided, the adapter calls `init()`
   * immediately, which starts the first `/get-session` read from module
   * evaluation — typically before React renders the Provider.
   *
   * Omit to defer initialisation until `ParcaeProvider` calls `init()`.
   */
  baseUrl?: string;

  /**
   * Pre-constructed Better Auth client. Pass this when your app already
   * holds a singleton `createAuthClient()` instance (e.g. for direct
   * sign-in/sign-out UI calls) so the adapter shares the *same* client.
   *
   * Sharing is critical: every `createAuthClient()` call creates its own
   * `session` atom. If the UI calls `signOut()` on one client and the
   * adapter watches a different client, the adapter never sees the
   * change and Parcae's session machine stays stuck.
   *
   * When `client` is provided, `baseUrl` is ignored (the client already
   * has its own base URL configured).
   */
  client?: Client;
}

const tokenOf = (value: Session): string | null => value.data?.session?.token ?? null;

export function betterAuth(opts: BetterAuthOptions = {}): AuthClientAdapter {
  let client: Client | null = opts.client ?? null;
  let session: SessionAtom | null = null;
  // The last settled token. `undefined` until the first settled read —
  // distinct from `null`, a confirmed anonymous session — so that read
  // sets the baseline instead of reporting a sign-in or a sign-out.
  let lastToken: string | null | undefined = undefined;
  const callbacks = new Set<(token: string | null) => void>();

  const start = (baseUrl?: string): void => {
    if (!client && baseUrl) {
      client = createAuthClient({ baseURL: baseUrl, basePath: '/v1/auth' });
    }
    // The server renders without a session, and a watched atom would
    // start Better Auth's focus and broadcast managers there.
    if (!client || session || typeof window === 'undefined') return;
    // boundary: Better Auth types `$store.atoms` as a loose record.
    session = (client.$store.atoms as unknown as { session: SessionAtom }).session;
    const now = session.get();
    if (!now.isPending) lastToken = tokenOf(now);
    // Never released: the adapter lives as long as the app. A failed
    // read keeps the last data, so only a read that proves a change
    // reaches the callbacks.
    session.listen((value) => {
      if (value.isPending) return;
      const token = tokenOf(value);
      if (token === lastToken) return;
      const baselining = lastToken === undefined;
      lastToken = token;
      if (baselining) return;
      for (const callback of [...callbacks]) callback(token);
    });
  };

  start(opts.baseUrl);

  return {
    // Idempotent — an eager adapter already watches its client.
    init: start,

    getToken(): Promise<string | null> {
      const atom = session;
      if (!atom) return Promise.resolve(null);
      const now = atom.get();
      if (!now.isPending) return Promise.resolve(tokenOf(now));
      return new Promise((resolve) => {
        const stop = atom.listen((value) => {
          if (value.isPending) return;
          stop();
          resolve(tokenOf(value));
        });
      });
    },

    onChange(callback: (token: string | null) => void): () => void {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
  };
}
