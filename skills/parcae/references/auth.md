# Authentication Reference

## AuthAdapter Interface

Source: `packages/backend/src/auth.ts`

```typescript
interface AuthAdapter {
  setup(ctx: AuthSetupContext): Promise<void>;
  resolveRequest(req): Promise<AuthSession | null>;
  resolveToken(token): Promise<AuthSession | null>;
  routes?: { basePath: string; handler: (req, res) => void } | null;
}

interface AuthSetupContext {
  userModel: ModelConstructor | null; // The User model class, if one exists
  adapter: BackendAdapter;
  config: Config;
  db: any; // Knex write instance
  ensureSchema?: boolean;
}

interface AuthSession {
  user: { id: string; [key: string]: any };
  session?: any;
}
```

Auth adapters run during `createApp()` startup, before schema migration. They can create their own tables and middleware.

## Better Auth (`@parcae/auth-betterauth`)

Source: `packages/auth-betterauth/src/index.ts`

Self-hosted auth using the same Postgres database.

### Server Setup

```typescript
import { createApp } from "@parcae/backend";
import { betterAuth } from "@parcae/auth-betterauth";

const app = createApp({
  models: [User, Post],
  auth: betterAuth({
    providers: ["email"], // "email", "google", "github"
    google: { clientId, clientSecret },
    github: { clientId, clientSecret },
  }),
});
```

### How It Works

- Shares Parcae's Postgres connection via `pg.Pool`
- Points Better Auth at the User model's table (convention: `type "user"` -> table `"users"`)
- Infers `additionalFields` from User model schema (excludes Better Auth's own fields: name, email, emailVerified, image, createdAt, updatedAt)
- Uses Parcae's `generateId()` for ID consistency
- Auth tables: `users`, `sessions`, `accounts`, `verifications`
- Bearer plugin for token-based auth
- Routes mounted at `/v1/auth/*`
- 30-day sessions, 24-hour refresh

### Session Resolution

1. HTTP: `resolveRequest(req)` reads `Authorization: Bearer <token>` header
2. Socket: `resolveToken(token)` called during `"authenticate"` event
3. Both return `{ user, session }` or `null`

### Client Setup

Source: `packages/auth-betterauth/src/client.ts`

```typescript
import { betterAuth } from "@parcae/auth-betterauth/client";
import { ParcaeProvider } from "@parcae/sdk/react";

<ParcaeProvider url="http://localhost:3000" auth={betterAuth()}>
  <App />
</ParcaeProvider>
```

Uses `better-auth/react` `createAuthClient` internally. Polls on visibility change for session updates. Implements `AuthClientAdapter`:

```typescript
{
  init(baseUrl): void;                          // Creates Better Auth client
  getToken(): Promise<string | null>;           // Gets bearer token from session
  onChange(cb: (token) => void): () => void;     // Session change subscription
}
```

### User Model Convention

If you have a model with `static type = "user"`, Better Auth shares its table:

```typescript
class User extends Model {
  static type = "user" as const;

  // Better Auth fields (managed by auth)
  name: string = "";
  email: string = "";
  emailVerified: boolean = false;
  image?: string;

  // Custom fields (added as additionalFields)
  bio: string = "";
  role: "user" | "admin" = "user";
}
```

## Clerk (`@parcae/auth-clerk`)

Source: `packages/auth-clerk/src/index.ts`

External auth with local user proxying.

### Server Setup

```typescript
import { clerk } from "@parcae/auth-clerk";

const app = createApp({
  models: [User],
  auth: clerk({
    secretKey: process.env.CLERK_SECRET_KEY,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
    mapUser: (clerkUser) => ({
      // Optional field mapping
      name: `${clerkUser.firstName} ${clerkUser.lastName}`,
      avatar: clerkUser.imageUrl,
    }),
    webhookSecret: process.env.CLERK_WEBHOOK_SECRET, // Optional Svix webhook
  }),
});
```

### How It Works

- Verifies session tokens via `@clerk/backend` `verifyToken()`
- On first-seen user: fetches from Clerk API, creates local User record
- Uses Clerk user ID as local user ID
- Optional webhook sync via Svix (`user.created`, `user.updated`, `user.deleted`)

### Auth Flow

1. Request arrives with Clerk session token
2. `verifyToken()` validates JWT
3. Look up local User by Clerk ID
4. If not found: fetch from Clerk API, create local record via `mapUser()`
5. Return `{ user }` session
