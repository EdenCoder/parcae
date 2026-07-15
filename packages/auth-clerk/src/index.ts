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
 *     authorizedParties: ["https://app.example.com"],
 *     webhookSecret: process.env.CLERK_WEBHOOK_SECRET, // optional
 *   }),
 * });
 * ```
 */

import { createClerkClient, verifyToken } from "@clerk/backend";
import {
  log,
  type AuthAdapter,
  type AuthSession,
  type AuthSetupContext,
  type BackendAdapter,
} from "@parcae/backend";
import type { ModelConstructor } from "@parcae/model";
import { Webhook } from "svix";

const CLERK_TOMBSTONE_TABLE = "parcae_clerk_user_tombstone";
const DELETED_USER = Symbol("deleted-user");

// ─── Configuration ───────────────────────────────────────────────────────────

export interface ClerkConfig {
  /** Clerk secret key (sk_...). Required. */
  secretKey: string;
  /** Clerk publishable key (pk_...). Used to build the Clerk API client. */
  publishableKey: string;
  /** Allowed JWT `azp` origins. Passes through to Clerk token verification. */
  authorizedParties?: string[];
  /** Clerk webhook signing secret (whsec_...). Optional — enables webhook sync. */
  webhookSecret?: string;
  /** Webhook mount prefix. Default: "/webhooks/clerk" */
  webhookPath?: string;
  /**
   * Custom mapping from Clerk user data to your User model.
   * Default maps: id, name (firstName + lastName), email, image.
   */
  mapUser?: (clerkUser: any) => Record<string, any>;
  /**
   * Names of additional Clerk JWT claims to surface on session.user.
   * Use when the Clerk session token template publishes custom keys
   * (e.g. {{user.public_metadata.X}}) and the application wants
   * to read them via session.user.X. Absent / empty = no extras.
   * Values pass through unmodified; consumers do their own type coercion.
   */
  publishClaims?: string[];
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
  let hasTombstoneTable = false;
  const deletedUsers = new Set<string>();
  const userOperations = new Map<string, Promise<void>>();

  async function serializeUser<T>(id: string, operation: () => Promise<T>) {
    const previous = userOperations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    userOperations.set(id, tail);
    try {
      return await current;
    } finally {
      if (userOperations.get(id) === tail) userOperations.delete(id);
    }
  }

  async function withDatabaseUserLock<T>(
    localAdapter: BackendAdapter,
    id: string,
    operation: (trx: any) => Promise<T>,
  ): Promise<T> {
    return localAdapter.runInTransaction(async (trx) => {
      await trx.raw(
        "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
        [`@parcae/auth-clerk:${id}`],
      );
      return operation(trx);
    });
  }

  async function hasDeletionTombstone(trx: any, id: string): Promise<boolean> {
    if (!hasTombstoneTable) return false;
    return Boolean(
      await trx(CLERK_TOMBSTONE_TABLE).where("userId", id).first(),
    );
  }

  async function upsertLocalUser(
    localUserModel: ModelConstructor,
    localAdapter: BackendAdapter,
    id: string,
    userData: Record<string, any>,
  ): Promise<any> {
    const existing = await localAdapter.findById(localUserModel, id);
    if (existing) {
      Object.assign(existing as object, userData);
      await localAdapter.save(existing);
      return existing;
    }

    // Every Model subclass inherits hydrate(). Unlike Model.create(), this
    // binds persistence to the adapter captured by setup and marks the model
    // as an upsert, so concurrent provisioning never duplicates create hooks.
    const hydratable = localUserModel as ModelConstructor & {
      hydrate(
        adapter: BackendAdapter,
        data: Record<string, any>,
      ): Record<string, any>;
    };
    const instance = hydratable.hydrate(localAdapter, { ...userData, id });
    await localAdapter.save(instance);
    return instance;
  }

  // ── Proxy: ensure local User exists for a Clerk user ID ──────────

  async function ensureLocalUser(clerkUserId: string): Promise<any> {
    const localUserModel = userModel;
    const localAdapter = adapter;
    if (!localUserModel || !localAdapter) return null;

    return serializeUser(clerkUserId, async () => {
      if (deletedUsers.has(clerkUserId)) return null;

      const current = await withDatabaseUserLock(
        localAdapter,
        clerkUserId,
        async (trx) => {
          if (await hasDeletionTombstone(trx, clerkUserId)) {
            return DELETED_USER;
          }
          return localAdapter.findById(localUserModel, clerkUserId);
        },
      );
      if (current === DELETED_USER) return null;
      if (current) return current;

      const clerkUser = await clerkClient.users.getUser(clerkUserId);
      if (deletedUsers.has(clerkUserId)) return null;
      const userData = mapUser(clerkUser);

      const provisioned = await withDatabaseUserLock(
        localAdapter,
        clerkUserId,
        async (trx) => {
          if (
            deletedUsers.has(clerkUserId) ||
            await hasDeletionTombstone(trx, clerkUserId)
          ) {
            return null;
          }
          return upsertLocalUser(
            localUserModel,
            localAdapter,
            clerkUserId,
            userData,
          );
        },
      );
      return deletedUsers.has(clerkUserId) ? null : provisioned;
    });
  }

  // ── Resolve a session token to a user ID ─────────────────────────

  async function resolveSessionToken(
    token: string,
  ): Promise<AuthSession | null> {
    let payload;
    try {
      payload = await verifyToken(token, {
        secretKey: config.secretKey,
        authorizedParties: config.authorizedParties,
      });
    } catch {
      return null;
    }

    const userId = payload.sub;
    if (!userId) return null;

    try {
      const localUser = await ensureLocalUser(userId);
      if (!localUser) return null;
    } catch (err) {
      log.error(
        `[parcae/auth-clerk] Failed to provision local user ${userId}:`,
        err,
      );
      return null;
    }

    // Extract org context from Clerk JWT.
    // Clerk uses `o.id` for org ID in the JWT payload (not `org_id`).
    const orgId = (payload as any).o?.id ?? (payload as any).org_id ?? null;
    const orgSlug =
      (payload as any).o?.slg ?? (payload as any).org_slug ?? null;

    // The JWT doesn't include the role — resolve via Clerk API.
    let orgRole: string | null = null;
    if (orgId) {
      try {
        const memberships =
          await clerkClient.users.getOrganizationMembershipList({
            userId,
          });
        const membership = memberships.data?.find(
          (m: any) => m.organization.id === orgId,
        );
        orgRole = membership?.role ?? null;
      } catch {
        // Clerk API may fail — proceed without role
      }
    }

    // Pass through `fva` (factor verification age) — Clerk default JWT
    // claim that lets a step-up gate know if/when the second factor
    // was last verified in the current session. `fva[1] === -1` means
    // no second factor was verified.
    const fva = (payload as any).fva;

    // Pass through any extra claim names listed in config.publishClaims.
    // Values come straight from the verified JWT payload; consumers do
    // their own type coercion.
    const extras: Record<string, unknown> = {};
    for (const key of config.publishClaims ?? []) {
      if (key in (payload as object)) {
        extras[key] = (payload as Record<string, unknown>)[key];
      }
    }

    return {
      user: {
        id: userId,
        ...(orgId && { orgId }),
        ...(orgRole && { orgRole }),
        ...(orgSlug && { orgSlug }),
        ...extras,
        ...(Array.isArray(fva) && fva.length === 2 && { fva }),
      },
    };
  }

  return {
    routes: null, // populated in setup() if webhookSecret is provided

    async setup(ctx: AuthSetupContext) {
      userModel = ctx.userModel;
      adapter = ctx.adapter;

      // Set up webhook handler for user sync (if secret provided)
      if (config.webhookSecret) {
        await ctx.db.raw(
          `CREATE TABLE IF NOT EXISTS ${CLERK_TOMBSTONE_TABLE} (` +
            `"userId" varchar(255) PRIMARY KEY, ` +
            `"deletedAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
        );
        hasTombstoneTable = true;
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
              const body = req.rawBody;
              if (!Buffer.isBuffer(body)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Missing raw webhook body" }));
                return;
              }
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
                  await serializeUser(clerkUser.id, async () => {
                    if (deletedUsers.has(clerkUser.id)) return;
                    await withDatabaseUserLock(
                      adapter!,
                      clerkUser.id,
                      async (trx) => {
                        if (await hasDeletionTombstone(trx, clerkUser.id)) return;
                        await upsertLocalUser(
                          userModel!,
                          adapter!,
                          clerkUser.id,
                          userData,
                        );
                      },
                    );
                  });
                  break;
                }

                case "user.deleted": {
                  if (!userModel || !adapter) break;
                  const clerkUser = event.data;
                  deletedUsers.add(clerkUser.id);
                  await serializeUser(clerkUser.id, async () => {
                    await withDatabaseUserLock(
                      adapter!,
                      clerkUser.id,
                      async (trx) => {
                        const deletedAt = new Date();
                        await trx(CLERK_TOMBSTONE_TABLE)
                          .insert({ userId: clerkUser.id, deletedAt })
                          .onConflict("userId")
                          .merge({ deletedAt });
                        const existing = await adapter!.findById(
                          userModel!,
                          clerkUser.id,
                        );
                        if (existing) await adapter!.remove(existing);
                      },
                    );
                  });
                  break;
                }
              }

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ received: true }));
            } catch (err) {
              log.error(
                "[parcae/auth-clerk] Webhook processing error:",
                err,
              );
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Internal error" }));
            }
          },
        };
      }
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
export type {
  AuthAdapter,
  AuthSession,
  AuthSetupContext,
} from "@parcae/backend";
