/**
 * @parcae/auth-betterauth
 *
 * Better Auth adapter for Parcae. Self-hosted authentication that uses
 * your Parcae User Model as the users table.
 *
 * @example
 * ```typescript
 * import { createApp } from "@parcae/backend";
 * import { betterAuth } from "@parcae/auth-betterauth";
 *
 * const app = createApp({
 *   models: [User, Post],
 *   auth: betterAuth({
 *     providers: ["email", "google"],
 *     google: { clientId: "...", clientSecret: "..." },
 *   }),
 * });
 * ```
 */

import { betterAuth as createBetterAuth } from "better-auth";
import { log } from "@parcae/backend";
import { bearer } from "better-auth/plugins/bearer";
import pg from "pg";
import { generateId } from "@parcae/model";
import type { ModelConstructor, SchemaDefinition } from "@parcae/model";
import type {
  AuthAdapter,
  AuthSession,
  AuthSetupContext,
} from "@parcae/backend";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface BetterAuthConfig {
  /** Enabled auth providers. Default: ["email"] */
  providers?: ("email" | "google" | "github")[];
  /** Google OAuth config. */
  google?: { clientId: string; clientSecret: string };
  /** GitHub OAuth config. */
  github?: { clientId: string; clientSecret: string };
  /** Session config. */
  session?: { expiresIn?: number; updateAge?: number };
  /** Trusted origins for CORS (in addition to TRUSTED_ORIGINS env var). */
  trustedOrigins?: string[];
  /** Auth route prefix. Default: "/v1/auth" */
  basePath?: string;
  /** Base URL (for OAuth callbacks). Auto-detected from PORT if not set. */
  baseURL?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Infer Better Auth `additionalFields` from the User model's schema.
 * Fields that Better Auth already manages (name, email, emailVerified, image,
 * createdAt, updatedAt, id) are excluded.
 */
function inferAdditionalFields(
  userModel: ModelConstructor,
): Record<
  string,
  { type: "string" | "number" | "boolean" | "date"; required: boolean }
> {
  const schema = (userModel as any).__schema as SchemaDefinition | undefined;
  if (!schema) return {};

  const betterAuthFields = new Set([
    "id",
    "name",
    "email",
    "emailVerified",
    "image",
    "createdAt",
    "updatedAt",
  ]);

  const fields: Record<
    string,
    { type: "string" | "number" | "boolean" | "date"; required: boolean }
  > = {};

  for (const [key, colDef] of Object.entries(schema)) {
    if (betterAuthFields.has(key)) continue;

    // Map Parcae column types to Better Auth field types
    const colType = typeof colDef === "string" ? colDef : "string";
    let baType: "string" | "number" | "boolean" | "date";
    switch (colType) {
      case "boolean":
        baType = "boolean";
        break;
      case "integer":
      case "number":
        baType = "number";
        break;
      case "datetime":
        baType = "date";
        break;
      default:
        baType = "string";
        break;
    }

    fields[key] = { type: baType, required: false };
  }

  return fields;
}

// ─── betterAuth() — factory function ─────────────────────────────────────────

/**
 * Create a Better Auth adapter for Parcae.
 *
 * The User Model is a real, managed Parcae Model. Better Auth writes auth fields
 * (email, name, image, emailVerified) into the same table. Your custom fields
 * (bio, role, plan, etc.) live alongside them.
 *
 * Sessions, accounts, and verifications are internal Better Auth tables —
 * created automatically by this adapter.
 */
export function betterAuth(config: BetterAuthConfig = {}): AuthAdapter {
  const basePath = config.basePath ?? "/v1/auth";

  let auth: any = null;

  return {
    routes: null, // populated in setup()

    async setup(ctx: AuthSetupContext) {
      const { userModel, config: envConfig, db } = ctx;

      const secret = envConfig.AUTH_SECRET;
      if (!secret) {
        throw new Error(
          "[parcae/auth-betterauth] AUTH_SECRET is required when auth is enabled.\n" +
            "Set it in .env or your environment.",
        );
      }

      const baseURL =
        config.baseURL ??
        envConfig.BACKEND_URL ??
        `http://localhost:${envConfig.PORT}`;

      // Social providers
      const socialProviders: Record<string, any> = {};
      const providers = config.providers ?? ["email"];

      if (providers.includes("google") && config.google) {
        socialProviders.google = {
          clientId: config.google.clientId,
          clientSecret: config.google.clientSecret,
        };
      }

      if (providers.includes("github") && config.github) {
        socialProviders.github = {
          clientId: config.github.clientId,
          clientSecret: config.github.clientSecret,
        };
      }

      // Trusted origins
      const trustedOrigins = [
        ...(config.trustedOrigins ?? []),
        ...(envConfig.TRUSTED_ORIGINS?.split(",").map((o) => o.trim()) ?? []),
        "http://localhost:*",
      ].filter(Boolean);

      // Determine user table name from the Model
      // Convention: type "user" → table "users"
      const userTableName = userModel ? (userModel as any).type + "s" : "users";

      // Infer additional fields from the User model schema
      const additionalFields = userModel
        ? inferAdditionalFields(userModel)
        : {};

      // Create Better Auth instance — shares Parcae's Postgres connection
      auth = createBetterAuth({
        basePath,
        baseURL,
        secret,

        // Use Parcae's database connection
        database: new pg.Pool({
          connectionString: envConfig.DATABASE_URL,
        }),

        // Point Better Auth at the Parcae User model's table
        user: {
          modelName: userTableName,
          additionalFields:
            Object.keys(additionalFields).length > 0
              ? additionalFields
              : undefined,
        },

        session: {
          modelName: "sessions",
          expiresIn: config.session?.expiresIn ?? 60 * 60 * 24 * 30, // 30 days
          updateAge: config.session?.updateAge ?? 60 * 60 * 24, // refresh daily
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

        // Use Parcae's ID generator for consistency
        advanced: {
          database: {
            generateId: () => generateId(),
          },
        },
      });

      // Populate routes for the framework to mount
      (this as any).routes = {
        basePath,
        handler: async (req: any, res: any) => {
          // Convert Polka/Node request to Web Fetch Request for Better Auth
          const url = `${baseURL}${req.url}`;

          const webRequest = new Request(url, {
            method: req.method,
            headers: new Headers(req.headers as Record<string, string>),
            body:
              req.method !== "GET" && req.method !== "HEAD"
                ? JSON.stringify(req.body)
                : undefined,
          });

          const response = await auth!.handler(webRequest);
          if (response && typeof response.status === "number") {
            const headers: Record<string, string> = {};
            response.headers.forEach((value: string, key: string) => {
              headers[key] = value;
            });
            res.writeHead(response.status, headers);
            const body = await response.text();
            res.end(body);
          }
        },
      };

      log.info(
        `[parcae/auth-betterauth] Configured (${providers.join(", ")}) → table: ${userTableName}`,
      );
    },

    async resolveRequest(req: any): Promise<AuthSession | null> {
      if (!auth) return null;

      try {
        const session = await auth.api.getSession({
          headers: new Headers(req.headers as Record<string, string>),
        });
        if (!session?.user) return null;
        return { user: session.user as { id: string; [key: string]: any } };
      } catch {
        return null;
      }
    },

    async resolveToken(token: string): Promise<AuthSession | null> {
      if (!auth) return null;

      try {
        const session = await auth.api.getSession({
          headers: new Headers({ authorization: `Bearer ${token}` }),
        });
        if (!session?.user) return null;
        return { user: session.user as { id: string; [key: string]: any } };
      } catch {
        return null;
      }
    },
  };
}

export default betterAuth;
export type {
  AuthAdapter,
  AuthSession,
  AuthSetupContext,
} from "@parcae/backend";
