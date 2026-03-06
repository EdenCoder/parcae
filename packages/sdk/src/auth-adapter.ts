/**
 * Client-side auth adapter interface.
 *
 * Parcae calls this internally to resolve sessions.
 * The adapter receives the base URL from ParcaeProvider — no config needed.
 */

export interface AuthClientAdapter {
  /** Initialize with the Parcae backend URL. Called by ParcaeProvider. */
  init(baseUrl: string): void;

  /** Get the current session token. null = no session. */
  getToken(): Promise<string | null>;

  /** Subscribe to session changes. Returns unsubscribe. */
  onChange(callback: (token: string | null) => void): () => void;
}
