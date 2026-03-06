/**
 * @parcae/backend — Auth Adapter Interface
 *
 * Auth is pluggable. The framework doesn't care HOW you authenticate —
 * it only needs to know WHO is making the request.
 *
 * Auth adapters implement this interface. The framework provides:
 * - @parcae/auth-betterauth — Better Auth (self-hosted, same Postgres)
 * - @parcae/auth-clerk — Clerk (external, proxied to local User model)
 *
 * The User Model is always a real, managed Parcae Model.
 * Auth adapters resolve identity and sync user data into it.
 */

import type { ModelConstructor } from "@parcae/model";
import type { BackendAdapter } from "./adapters/model";
import type { Config } from "./config";

// ─── AuthAdapter Interface ───────────────────────────────────────────────────

export interface AuthAdapter {
  /**
   * Called once at startup after the database and adapter are ready.
   *
   * Use this to:
   * - Configure the auth provider against the database
   * - Register webhook routes or sync hooks
   * - Run any provider-specific migrations (sessions, accounts, etc.)
   */
  setup(ctx: AuthSetupContext): Promise<void>;

  /**
   * Resolve an HTTP request to an authenticated session.
   * Returns null if the request is unauthenticated.
   *
   * The returned session is set on `req.session` for route handlers and scopes.
   */
  resolveRequest(req: any): Promise<AuthSession | null>;

  /**
   * Resolve a bearer token to an authenticated session.
   * Used for Socket.IO authentication via the `authenticate` event.
   */
  resolveToken(token: string): Promise<AuthSession | null>;

  /**
   * Optional: HTTP routes the auth provider needs mounted.
   *
   * Better Auth: { basePath: "/v1/auth", handler: auth.handler }
   * Clerk: { basePath: "/webhooks/clerk", handler: webhookHandler } or null
   */
  routes?: {
    basePath: string;
    handler: (req: any, res: any) => Promise<void> | void;
  } | null;
}

// ─── Supporting Types ────────────────────────────────────────────────────────

export interface AuthSession {
  /** The authenticated user. `id` maps to the User Model's ID. */
  user: { id: string; [key: string]: any };
  /** Optional: raw session/token data from the provider. */
  [key: string]: any;
}

export interface AuthSetupContext {
  /**
   * The User model class, if one is registered with `static type = "user"`.
   * Auth adapters use this to determine the table name and schema.
   */
  userModel: ModelConstructor | null;

  /** The BackendAdapter — for database operations. */
  adapter: BackendAdapter;

  /** Parsed and validated environment config. */
  config: Config;

  /**
   * Knex write instance — for auth providers that need direct DB access.
   * Better Auth uses this to share Parcae's database connection.
   */
  db: any;
}
