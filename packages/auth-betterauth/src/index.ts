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
import type { Pool } from "pg";
import pluralize from "pluralize";
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
  providers?: ("email" | "google" | "github" | "apple")[];
  /** Google OAuth config. */
  google?: { clientId: string; clientSecret: string };
  /** GitHub OAuth config. */
  github?: { clientId: string; clientSecret: string };
  /**
   * Apple config. Native iOS sign-in only needs `appBundleIdentifier`
   * (idToken audience = bundle id, verified against Apple's public keys);
   * `clientId` (Services ID) + `clientSecret` (self-minted ES256 JWT) are
   * required only for the web/Android OAuth flow.
   */
  apple?: { clientId?: string; clientSecret?: string; appBundleIdentifier?: string };
  /** Session config. */
  session?: { expiresIn?: number; updateAge?: number };
  /** Trusted origins for CORS (in addition to TRUSTED_ORIGINS env var). */
  trustedOrigins?: string[];
  /** Auth route prefix. Default: "/v1/auth" */
  basePath?: string;
  /** Base URL (for OAuth callbacks). Auto-detected from PORT if not set. */
  baseURL?: string;
  /**
   * Passthrough merged into Better Auth's `emailAndPassword` options — e.g. a
   * custom `password.hash` / `password.verify` to validate legacy password
   * hashes after a migration. `enabled` is still derived from `providers`, so
   * callers only supply the extras. */
  emailAndPassword?: {
    password?: {
      hash?: (password: string) => Promise<string>;
      verify?: (data: { hash: string; password: string }) => Promise<boolean>;
    };
  };
  /**
   * Explicit allowlists for custom User fields. Inferred fields are private
   * to Better Auth by default: they cannot be written through auth endpoints
   * or returned in auth profiles unless listed here. Custom Model
   * `privateFields` always remain non-returned.
   */
  userFields?: {
    input?: readonly string[];
    returned?: readonly string[];
  };
  /**
   * Optional app-owned pg Pool. Better Auth cannot consume Parcae's Knex
   * pool directly; when omitted, this adapter owns a dedicated tracked pool.
   */
  database?: Pool;
}

export interface BetterAuthAdapter extends AuthAdapter {
  /** Close the adapter-owned database pool. App-owned pools are untouched. */
  close(): Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BETTER_AUTH_MANAGED_FIELDS = [
  "id",
  "name",
  "email",
  "emailVerified",
  "image",
  "createdAt",
  "updatedAt",
] as const;

/**
 * Infer Better Auth `additionalFields` from the User model's schema.
 * Fields that Better Auth already manages (name, email, emailVerified, image,
 * createdAt, updatedAt, id) are excluded.
 */
export function inferAdditionalFields(
  userModel: ModelConstructor,
  allowlists: BetterAuthConfig["userFields"] = {},
): Record<
  string,
  {
    type: "string" | "number" | "boolean" | "date";
    required: boolean;
    input: boolean;
    returned: boolean;
  }
> {
  const schema = (userModel as any).__schema as SchemaDefinition | undefined;
  if (!schema) return {};

  const betterAuthFields = new Set<string>(BETTER_AUTH_MANAGED_FIELDS);

  const fields: Record<
    string,
    {
      type: "string" | "number" | "boolean" | "date";
      required: boolean;
      input: boolean;
      returned: boolean;
    }
  > = {};
  const inputFields = new Set(allowlists.input ?? []);
  const returnedFields = new Set(allowlists.returned ?? []);
  const privateFields = new Set(userModel.privateFields ?? []);

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

    const isPrivate = privateFields.has(key);
    fields[key] = {
      type: baType,
      required: false,
      input: !isPrivate && inputFields.has(key),
      returned: !isPrivate && returnedFields.has(key),
    };
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
export function betterAuth(config: BetterAuthConfig = {}): BetterAuthAdapter {
  const basePath = config.basePath ?? "/v1/auth";

  let auth: any = null;
  let database: Pool | null = null;
  let ownsDatabase = false;

  const adapter: BetterAuthAdapter = {
    routes: null, // populated in setup()

    async close() {
      auth = null;
      adapter.routes = null;
      const pool = database;
      database = null;
      if (pool && ownsDatabase) await pool.end();
      ownsDatabase = false;
    },

    async setup(ctx: AuthSetupContext) {
      const { userModel, config: envConfig, ensureSchema } = ctx;

      const managedPrivateFields = BETTER_AUTH_MANAGED_FIELDS.filter((field) =>
        userModel?.privateFields?.includes(field),
      );
      if (managedPrivateFields.length > 0) {
        throw new Error(
          `[parcae/auth-betterauth] User.privateFields cannot include Better Auth-managed returned fields: ${managedPrivateFields.join(", ")}. These built-in fields cannot be hidden from Better Auth responses.`,
        );
      }

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

      if (providers.includes("apple") && config.apple) {
        socialProviders.apple = {
          clientId: config.apple.clientId ?? config.apple.appBundleIdentifier ?? "",
          clientSecret: config.apple.clientSecret ?? "unused-for-native-idtoken",
          appBundleIdentifier: config.apple.appBundleIdentifier,
        };
      }

      // Trusted origins
      const trustedOrigins = [
        ...(config.trustedOrigins ?? []),
        ...(envConfig.TRUSTED_ORIGINS?.split(",").map((o) => o.trim()) ?? []),
        "http://localhost:*",
      ].filter(Boolean);

      // Determine user table name from the Model. Must match the table
      // the BackendAdapter creates, which is `pluralize(type)` — so an
      // irregular user type (e.g. "person" → "people") still lines up.
      const userTableName = userModel
        ? pluralize((userModel as any).type)
        : "users";

      // Infer additional fields from the User model schema
      const additionalFields = userModel
        ? inferAdditionalFields(userModel, config.userFields)
        : {};

      database = config.database ?? new pg.Pool({
        connectionString: envConfig.DATABASE_URL,
      });
      ownsDatabase = !config.database;

      // Better Auth accepts pg.Pool but not Knex's internal Tarn pool. The
      // dedicated fallback is tracked by close() rather than leaked.
      auth = createBetterAuth({
        basePath,
        baseURL,
        secret,

        database,

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
          ...(config.emailAndPassword ?? {}),
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

      // Run Better Auth migrations to create auth tables (users, sessions, accounts, verifications)
      // This must happen BEFORE Parcae's ensureAllTables() so that the users table exists
      // for Parcae to add custom columns to.
      if (ensureSchema) {
        try {
          const authContext = await auth.$context;
          await authContext.runMigrations();
          log.info(
            "[parcae/auth-betterauth] Auth tables migrated (users, sessions, accounts, verifications)",
          );
        } catch (err) {
          log.error("[parcae/auth-betterauth] Auth migration failed:", err);
          await adapter.close();
          throw err;
        }
      }

      // Populate routes for the framework to mount
      adapter.routes = {
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
            const headers: Record<string, string | string[]> = {};
            response.headers.forEach((value: string, key: string) => {
              // Set-Cookie is handled separately — a plain object can't
              // hold more than one `set-cookie` entry, and `forEach`
              // comma-merges multiple cookies into a single corrupt
              // header. Better Auth sets >1 cookie on common flows
              // (e.g. `session_token` + `dont_remember` when a sign-in
              // passes `rememberMe: false`, or `session_data` with the
              // cookie cache), so collapsing here silently drops the
              // session cookie and every later get-session returns null.
              if (key.toLowerCase() === "set-cookie") return;
              headers[key] = value;
            });

            // Preserve EACH Set-Cookie as a distinct header. `getSetCookie()`
            // returns them as an array (undici/Node ≥18.14); Node's
            // writeHead emits one `Set-Cookie:` line per array element.
            const setCookies =
              typeof response.headers.getSetCookie === "function"
                ? response.headers.getSetCookie()
                : [];
            if (setCookies.length > 0) {
              headers["set-cookie"] = setCookies;
            }

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

  return adapter;
}
