/**
 * @parcae/backend — Better Auth integration
 *
 * Opt-in authentication. If `auth` config is provided to createApp(),
 * this module sets up Better Auth with the app's Postgres database.
 *
 * Features:
 * - Email/password + social OAuth (Google, GitHub)
 * - Bearer token sessions (for Socket.IO auth)
 * - Socket auth via handshake query or `authenticate` event
 * - `req.session.user` available in route handlers
 */

import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins/bearer";
import pg from "pg";
import type { Config } from "./config";

// ─── Auth Configuration ──────────────────────────────────────────────────────

export interface AuthConfig {
  /** Enabled auth providers. */
  providers?: ("email" | "google" | "github")[];
  /** Google OAuth config. */
  google?: { clientId: string; clientSecret: string };
  /** GitHub OAuth config. */
  github?: { clientId: string; clientSecret: string };
  /** Session config. */
  session?: { expiresIn?: number; updateAge?: number };
  /** Trusted origins for CORS. */
  trustedOrigins?: string[];
  /** Auth path prefix. Default: "/v1/auth" */
  basePath?: string;
  /** Base URL (for OAuth callbacks). Auto-detected if not set. */
  baseURL?: string;
}

// ─── Create Auth Instance ────────────────────────────────────────────────────

export function createAuth(authConfig: AuthConfig, envConfig: Config) {
  const basePath = authConfig.basePath ?? "/v1/auth";
  const baseURL = authConfig.baseURL ?? `http://localhost:${envConfig.PORT}`;
  const secret = envConfig.AUTH_SECRET;

  if (!secret) {
    throw new Error(
      "[parcae] AUTH_SECRET is required when auth is enabled.\n" +
        "Set it in .env or your environment.",
    );
  }

  const socialProviders: Record<string, any> = {};
  const providers = authConfig.providers ?? ["email"];

  if (providers.includes("google") && authConfig.google) {
    socialProviders.google = {
      clientId: authConfig.google.clientId,
      clientSecret: authConfig.google.clientSecret,
    };
  }

  if (providers.includes("github") && authConfig.github) {
    socialProviders.github = {
      clientId: authConfig.github.clientId,
      clientSecret: authConfig.github.clientSecret,
    };
  }

  const trustedOrigins = [
    ...(authConfig.trustedOrigins ?? []),
    ...(envConfig.TRUSTED_ORIGINS?.split(",").map((o) => o.trim()) ?? []),
    "http://localhost:*",
  ].filter(Boolean);

  const auth = betterAuth({
    basePath,
    baseURL,
    secret,

    database: new pg.Pool({
      connectionString: envConfig.DATABASE_URL,
    }),

    user: { modelName: "users" },

    session: {
      modelName: "sessions",
      expiresIn: authConfig.session?.expiresIn ?? 60 * 60 * 24 * 30, // 30 days
      updateAge: authConfig.session?.updateAge ?? 60 * 60 * 24, // refresh daily
    },

    account: {
      modelName: "accounts",
      accountLinking: { enabled: true },
    },

    verification: { modelName: "verifications" },

    emailAndPassword: {
      enabled: providers.includes("email"),
    },

    socialProviders:
      Object.keys(socialProviders).length > 0 ? socialProviders : undefined,
    trustedOrigins,
    plugins: [bearer()],
  });

  return auth;
}

/**
 * Create auth middleware for Polka.
 * Resolves req.session from Bearer token on every request.
 */
export function createAuthMiddleware(auth: ReturnType<typeof createAuth>) {
  return async (req: any, _res: any, next: () => void) => {
    try {
      const session = await auth.api.getSession({
        headers: new Headers(req.headers as Record<string, string>),
      });
      req.session = session;
    } catch {
      req.session = null;
    }
    next();
  };
}

/**
 * Create socket auth handler.
 * Resolves user from bearer token sent via authenticate event.
 */
export function createSocketAuthHandler(auth: ReturnType<typeof createAuth>) {
  return async (
    token: string,
    callback: (response: { userId: string | null }) => void,
  ) => {
    try {
      const session = await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
      callback({ userId: session?.user?.id ?? null });
      return session;
    } catch {
      callback({ userId: null });
      return null;
    }
  };
}

export type AuthInstance = ReturnType<typeof createAuth>;
export type Session =
  ReturnType<typeof createAuth> extends { $Infer: { Session: infer S } }
    ? S
    : any;
