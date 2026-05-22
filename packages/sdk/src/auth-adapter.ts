/**
 * Client-side auth adapter interface.
 *
 * The adapter is the source of truth for *the current bearer token*.
 * Parcae calls `getToken()` from the transport's hello/refresh
 * handshake — once before the initial connect and once per
 * reconnect or token rotation.
 *
 * The adapter publishes token changes via `onChange`. Token rotations
 * trigger `client.refreshSession()`; sign-out triggers
 * `client.terminateSession()`. The transport does *not* infer auth
 * state from socket lifecycle events.
 */

export interface AuthClientAdapter {
  /** Called once by ParcaeProvider before the transport is built. */
  init(baseUrl: string): void;

  /** Resolve the current bearer token. `null` = anonymous session. */
  getToken(): Promise<string | null>;

  /**
   * Subscribe to token changes. Fired on sign-in (non-null token),
   * sign-out (null), and rotation (different non-null token).
   * Returns unsubscribe.
   */
  onChange(callback: (token: string | null) => void): () => void;
}
