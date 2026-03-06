/**
 * @parcae/auth-clerk
 *
 * Clerk adapter for Parcae. External authentication proxied to your
 * local User model.
 *
 * Clerk manages users in their cloud. This adapter:
 * 1. Verifies session tokens on every request
 * 2. Proxies Clerk user data into your local User model on first seen
 * 3. Optionally syncs via Clerk webhooks (user.created, user.updated, user.deleted)
 *
 * @example
 * ```typescript
 * import { createApp } from "@parcae/backend";
 * import { clerk } from "@parcae/auth-clerk";
 *
 * const app = createApp({
 *   models: [User, Post],
 *   auth: clerk({
 *     secretKey: process.env.CLERK_SECRET_KEY!,
 *     publishableKey: process.env.CLERK_PUBLISHABLE_KEY!,
 *     webhookSecret: process.env.CLERK_WEBHOOK_SECRET, // optional
 *   }),
 * });
 * ```
 */

import { createClerkClient, verifyToken } from "@clerk/backend";
import { Webhook } from "svix";
import { Model } from "@parcae/model";
import type { ModelConstructor } from "@parcae/model";
import type {
  AuthAdapter,
  AuthSession,
  AuthSetupContext,
  BackendAdapter,
} from "@parcae/backend";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface ClerkConfig {
  /** Clerk secret key (sk_...). Required. */
  secretKey: string;
  /** Clerk publishable key (pk_...). Required for token verification. */
  publishableKey: string;
  /** Clerk webhook signing secret (whsec_...). Optional — enables webhook sync. */
  webhookSecret?: string;
  /** Webhook route path. Default: "/webhooks/clerk" */
  webhookPath?: string;
  /**
   * Custom mapping from Clerk user data to your User model.
   * Default maps: id, name (firstName + lastName), email, image.
   */
  mapUser?: (clerkUser: any) => Record<string, any>;
}

// ─── Default user mapping ────────────────────────────────────────────────────

function defaultMapUser(clerkUser: any): Record<string, any> {
  const primaryEmail = clerkUser.emailAddresses?.find(
    (e: any) => e.id === clerkUser.primaryEmailAddressId,
  );

  return {
    name: [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" "),
    email: primaryEmail?.emailAddress ?? "",
    image: clerkUser.imageUrl ?? "",
  };
}

// ─── clerk() — factory function ──────────────────────────────────────────────

/**
 * Create a Clerk auth adapter for Parcae.
 *
 * Users live in Clerk's cloud. This adapter proxies user data into your
 * local User model on first-seen and keeps it in sync via webhooks.
 */
export function clerk(config: ClerkConfig): AuthAdapter {
  const webhookPath = config.webhookPath ?? "/webhooks/clerk";
  const mapUser = config.mapUser ?? defaultMapUser;

  const clerkClient = createClerkClient({
    secretKey: config.secretKey,
    publishableKey: config.publishableKey,
  });

  let userModel: ModelConstructor | null = null;
  let adapter: BackendAdapter | null = null;

  // ── Proxy: ensure local User exists for a Clerk user ID ──────────

  async function ensureLocalUser(clerkUserId: string): Promise<any> {
    if (!userModel || !adapter) return null;

    // Check if user already exists locally
    const existing = await adapter.findById(userModel, clerkUserId);
    if (existing) return existing;

    // Fetch from Clerk and create locally
    try {
      const clerkUser = await clerkClient.users.getUser(clerkUserId);
      const userData = mapUser(clerkUser);

      const instance = Model.create.call(userModel, {
        ...userData,
        id: clerkUserId, // Use Clerk's user ID as the local ID
      }) as any;

      // Mark as not new to force an upsert (in case of race conditions)
      await instance.save();
      return instance;
    } catch (err) {
      console.warn(
        `[parcae/auth-clerk] Failed to proxy user ${clerkUserId}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  // ── Resolve a session token to a user ID ─────────────────────────

  async function resolveSessionToken(
    token: string,
  ): Promise<AuthSession | null> {
    try {
      const payload = await verifyToken(token, {
        secretKey: config.secretKey,
      });

      const userId = payload.sub;
      if (!userId) return null;

      // Ensure the user exists locally
      await ensureLocalUser(userId);

      return { user: { id: userId } };
    } catch {
      return null;
    }
  }

  return {
    routes: null, // populated in setup() if webhookSecret is provided

    async setup(ctx: AuthSetupContext) {
      userModel = ctx.userModel;
      adapter = ctx.adapter;

      // Set up webhook handler for user sync (if secret provided)
      if (config.webhookSecret) {
        const wh = new Webhook(config.webhookSecret);

        (this as any).routes = {
          basePath: webhookPath,
          handler: async (req: any, res: any) => {
            // Verify webhook signature
            const svixId = req.headers["svix-id"];
            const svixTimestamp = req.headers["svix-timestamp"];
            const svixSignature = req.headers["svix-signature"];

            if (!svixId || !svixTimestamp || !svixSignature) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing svix headers" }));
              return;
            }

            let event: any;
            try {
              const body =
                typeof req.body === "string"
                  ? req.body
                  : JSON.stringify(req.body);
              event = wh.verify(body, {
                "svix-id": svixId as string,
                "svix-timestamp": svixTimestamp as string,
                "svix-signature": svixSignature as string,
              });
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid webhook signature" }));
              return;
            }

            // Handle user events
            try {
              switch (event.type) {
                case "user.created":
                case "user.updated": {
                  if (!userModel || !adapter) break;
                  const clerkUser = event.data;
                  const userData = mapUser(clerkUser);

                  const existing = await adapter.findById(
                    userModel,
                    clerkUser.id,
                  );
                  if (existing) {
                    // Update existing local user
                    for (const [key, value] of Object.entries(userData)) {
                      (existing as any).__data[key] = value;
                    }
                    await (existing as any).save();
                  } else {
                    // Create new local user
                    const instance = Model.create.call(userModel, {
                      ...userData,
                      id: clerkUser.id,
                    }) as any;
                    await instance.save();
                  }
                  break;
                }

                case "user.deleted": {
                  if (!userModel || !adapter) break;
                  const clerkUser = event.data;
                  const existing = await adapter.findById(
                    userModel,
                    clerkUser.id,
                  );
                  if (existing) {
                    await (existing as any).remove();
                  }
                  break;
                }
              }

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ received: true }));
            } catch (err) {
              console.error(
                "[parcae/auth-clerk] Webhook processing error:",
                err,
              );
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Internal error" }));
            }
          },
        };

        console.log(
          `[parcae/auth-clerk] Webhook sync enabled at ${webhookPath}`,
        );
      }

      console.log(
        `[parcae/auth-clerk] Configured (proxy to ${userModel ? userModel.type + "s" : "no user model"} table)`,
      );
    },

    async resolveRequest(req: any): Promise<AuthSession | null> {
      const authHeader = req.headers?.authorization;
      if (!authHeader) return null;

      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : authHeader;

      return resolveSessionToken(token);
    },

    async resolveToken(token: string): Promise<AuthSession | null> {
      return resolveSessionToken(token);
    },
  };
}

export default clerk;
export type { AuthAdapter, AuthSession, AuthSetupContext } from "@parcae/backend";
