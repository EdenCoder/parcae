# Authentication Reference

Auth in Parcae is pluggable. An adapter resolves an incoming request or socket
token to an `AuthSession`, and optionally mounts its own HTTP routes (OAuth
callbacks, webhooks). Two adapters ship: Better Auth (self-hosted) and Clerk
(external). Both ultimately return only `{ user }`.

## AuthAdapter Interface

Source: `packages/backend/src/auth.ts`

```typescript
interface AuthAdapter {
  setup(ctx: AuthSetupContext): Promise<void>;
  close?(): Promise<void> | void;
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
  [key: string]: any;
}
```

Auth adapters run during `createApp()` startup. Adapters that own schema (Better
Auth) migrate their tables before Parcae's `ensureAllTables()` so Parcae can add
custom columns afterwards. `app.stop()` calls optional `auth.close()` before
destroying the Knex pools. Startup failures use the same teardown path.

### Session Resolution

1. HTTP: `resolveRequest(req)` reads `Authorization: Bearer <token>`.
2. Socket: `resolveToken(token)` is called on the socket `"hello"` handshake.
3. Both return an `AuthSession` (always `{ user }` in the shipped adapters) or
   `null` for anonymous.

---

## Better Auth (`@parcae/auth-betterauth`)

Source: `packages/auth-betterauth/src/index.ts`

Self-hosted auth that shares Parcae's Postgres database and uses your Parcae
`User` model as the Better Auth users table.

### Server Setup

```typescript
import { createApp } from "@parcae/backend";
import { betterAuth } from "@parcae/auth-betterauth";

const app = createApp({
  models: [User, Post],
  auth: betterAuth({
    providers: ["email", "google"], // "email" | "google" | "github"
    google: { clientId, clientSecret },
    github: { clientId, clientSecret },
  }),
});
```

`BetterAuthConfig`:

| Option           | Default       | Notes                                                       |
| ---------------- | ------------- | ----------------------------------------------------------- |
| `providers`      | `["email"]`   | Subset of `"email" \| "google" \| "github"`.                |
| `google`         | —             | `{ clientId, clientSecret }`; only used if in `providers`.  |
| `github`         | —             | `{ clientId, clientSecret }`; only used if in `providers`.  |
| `session`        | see below     | `{ expiresIn?, updateAge? }` in seconds.                    |
| `trustedOrigins` | `[]`          | Merged with `TRUSTED_ORIGINS` env + `http://localhost:*`.   |
| `basePath`       | `"/v1/auth"`  | Auth route prefix.                                          |
| `baseURL`        | auto          | OAuth callback base; see below.                             |

### AUTH_SECRET is required

`setup()` reads `config.AUTH_SECRET` and **throws at startup if it is unset**:

```
[parcae/auth-betterauth] AUTH_SECRET is required when auth is enabled.
```

There is no fallback or generated default — set `AUTH_SECRET` in the environment
before booting an app with Better Auth.

### Environment used at setup

- `AUTH_SECRET` — required (hard throw).
- `baseURL` resolution (for OAuth callbacks): `config.baseURL` → `BACKEND_URL`
  → `http://localhost:${PORT}`.
- `DATABASE_URL` — drives the `pg.Pool` Better Auth uses (shares Parcae's DB).
- `TRUSTED_ORIGINS` — comma-separated, merged into trusted origins.

### How It Works

- Creates its own tracked `pg.Pool` from `DATABASE_URL` (same database as
  Parcae), unless an app-owned `database` pool is supplied. `app.stop()` closes
  an adapter-owned pool and leaves an app-owned pool open.
- Points Better Auth's user table at `pluralize((userModel).type)` so it matches
  the table the `BackendAdapter` creates. It reads the model's **static `type`**,
  not the schema, so an irregular type lines up: `user` → `users`,
  `person` → `people`. Falls back to `"users"` if there is no user model.
- Infers Better Auth `additionalFields` from the user model's `__schema`,
  excluding the fields Better Auth manages itself: **`id`, `name`, `email`,
  `emailVerified`, `image`, `createdAt`, `updatedAt`**. Parcae column types map
  to Better Auth types (`boolean`→`boolean`, `integer`/`number`→`number`,
  `datetime`→`date`, else `string`); all inferred fields are `required: false`.
- Rejects `User.privateFields` containing any Better Auth-managed returned field:
  `id`, `name`, `email`, `emailVerified`, `image`, `createdAt`, or `updatedAt`.
  Better Auth cannot hide these built-ins.
- Uses Parcae's `generateId()` as Better Auth's `advanced.database.generateId`
  for ID consistency.
- Internal tables (created by Better Auth migrations): user table (e.g. `users`),
  `sessions`, `accounts` (account linking enabled), `verifications`. Migrations
  run only when `ensureSchema` is set, and run **before** Parcae's table sync.
- `bearer()` plugin enabled for token-based auth.
- Routes mounted at `basePath` (default `/v1/auth`); the handler adapts the
  Polka/Node request into a Web `Request` and delegates to `auth.handler`.
- Sessions: 30-day expiry (`60*60*24*30`), 24-hour `updateAge` refresh by default.

### Session Resolution

Both `resolveRequest` and `resolveToken` call Better Auth's
`auth.api.getSession`. `resolveRequest` forwards the incoming request headers;
`resolveToken` builds an `Authorization: Bearer <token>` header. Each returns
`{ user: session.user }` or `null` (errors are swallowed and become `null`).

### User Model Convention

A model with `static type = "user"` becomes the Better Auth users table. Better
Auth manages its own fields; your extra fields are added as `additionalFields`:

```typescript
class User extends Model {
  static type = "user" as const;

  // Managed by Better Auth (excluded from additionalFields)
  name: string = "";
  email: string = "";
  emailVerified: boolean = false;
  image?: string;

  // Custom fields → inferred as Better Auth additionalFields
  bio: string = "";
  role: "user" | "admin" = "user";
}
```

### Client Setup

Source: `packages/auth-betterauth/src/client.ts`

```typescript
import { betterAuth } from "@parcae/auth-betterauth/client";
import { ParcaeProvider } from "@parcae/sdk/react";

const auth = betterAuth({ baseUrl: process.env.NEXT_PUBLIC_API_URL });

<ParcaeProvider url={baseUrl} auth={auth}>
  <App />
</ParcaeProvider>;
```

`betterAuth(opts)` returns an `AuthClientAdapter`
(`{ init(baseUrl), getToken(), onChange(cb) }`). It wraps `createAuthClient`
from `better-auth/react`. `BetterAuthOptions`:

- **`baseUrl?`** — when provided, the adapter calls `init()` and fires the first
  `getSession()` eagerly at module evaluation (before the Provider's effect
  runs). The pending promise is cached and consumed by the first `getToken()`,
  saving a round trip. Omit it to defer until `ParcaeProvider` calls `init()`.
- **`client?`** — a pre-constructed `createAuthClient()` instance to **share**.

`getToken()` resolves the (primed or fresh) session and returns
`session.data.session.token ?? null`. The primed promise is one-shot — later
calls re-fetch, covering token rotation.

#### Shared-client footgun

Every `createAuthClient()` call creates its **own** `$sessionSignal` nanostore
atom. If your sign-in/sign-out UI uses its own `createAuthClient()` and you let
the adapter build a *different* client, the adapter listens on the wrong atom and
never sees sign-out — Parcae's session machine stays stuck. If your app already
holds a singleton auth client, pass it via `client` so the adapter shares it.
When `client` is set, `baseUrl` is ignored.

#### Reactivity (`onChange`)

`onChange` reacts to **in-tab** auth mutations by subscribing to better-auth's
`$sessionSignal` atom via nanostores' `listen()` (which fires only on
subsequent changes, not on attach). Better Auth bumps that atom after
auth-mutating requests (sign-in/up, sign-out, revoke-session(s), update-user,
update-session, verify-email, change-email, delete-user). A `visibilitychange`
listener is a secondary **cross-tab / external** fallback (another tab signed
out, or the server revoked the cookie). On each trigger it re-reads the session
and only invokes the callback when the token actually changed; transient endpoint
failures are ignored (not treated as sign-out).

---

## Clerk (`@parcae/auth-clerk`)

Source: `packages/auth-clerk/src/index.ts`

External auth: users live in Clerk's cloud and are proxied into a local User
model on first-seen.

### Server Setup

```typescript
import { clerk } from "@parcae/auth-clerk";

const app = createApp({
  models: [User],
  auth: clerk({
    secretKey: process.env.CLERK_SECRET_KEY!,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY!,
    authorizedParties: ["https://app.example.com"],
    webhookSecret: process.env.CLERK_WEBHOOK_SECRET, // optional
    publishClaims: ["plan", "feature_flags"], // optional
    mapUser: (clerkUser) => ({
      name: `${clerkUser.firstName} ${clerkUser.lastName}`,
      image: clerkUser.imageUrl,
    }),
  }),
});
```

`ClerkConfig`:

| Option              | Default              | Notes                                                  |
| ------------------- | -------------------- | ------------------------------------------------------ |
| `secretKey`        | —                    | `sk_...`. Required; used for JWT verification.         |
| `publishableKey`   | —                    | `pk_...`. Builds the Clerk API client.                 |
| `authorizedParties`| —                    | Allowed JWT `azp` origins passed to `verifyToken`.     |
| `webhookSecret`    | —                    | `whsec_...`. Enables Svix webhook sync when set.       |
| `webhookPath`      | `"/webhooks/clerk"`  | Webhook mount prefix; see exact endpoint below.        |
| `mapUser`          | `defaultMapUser`     | Maps a Clerk user to local fields.                     |
| `publishClaims`    | `[]`                 | Extra JWT claim names to surface on `session.user`.    |

Token verification passes `secretKey` and `authorizedParties` to `verifyToken`;
the latter validates the JWT `azp` claim when configured. `publishableKey` is
passed to `createClerkClient` for user and org-membership API calls.

`defaultMapUser` maps `name` (firstName + lastName joined), `email` (primary
email address), and `image` (`imageUrl`). Your `mapUser` replaces it entirely.

### How It Works

- `verifyToken()` validates the Clerk session JWT.
- On first-seen `payload.sub`: looks up the local User by that id; if absent,
  fetches from the Clerk API and creates a local record via `mapUser()`, using
  the **Clerk user ID as the local User id**.
- Optional webhook sync via Svix when `webhookSecret` is set, handling
  `user.created`, `user.updated`, `user.deleted` (verifies `svix-id`,
  `svix-timestamp`, `svix-signature`).

The backend mounts auth handlers at `${basePath}/*`. Clerk's `webhookPath` is
therefore a mount prefix, and the exact default webhook URL configured in Clerk
must be `https://api.example.com/webhooks/clerk/events`; the final non-empty
segment is required by the wildcard mount.

### Auth Flow & Session Shape

`resolveRequest` strips the `Bearer ` prefix; `resolveToken` takes the raw token.
Both delegate to the same verifier, which returns `{ user }` where `user`
contains:

- **`id`** — `payload.sub`.
- **`orgId`** — from the JWT `o.id` (Clerk's compact org claim), falling back to
  `org_id`. Omitted when absent.
- **`orgSlug`** — from `o.slg`, falling back to `org_slug`. Omitted when absent.
- **`orgRole`** — the JWT does **not** carry the role; it is resolved with an
  extra Clerk API call (`users.getOrganizationMembershipList`) matching the
  membership for `orgId`. If the API call fails, the session proceeds without a
  role. Omitted when null.
- **`fva`** — Clerk's factor-verification-age claim, passed through verbatim when
  it is a 2-element array. `fva[1] === -1` means no second factor was verified
  (useful for step-up/2FA gates).
- **`...publishClaims`** — for each name in `config.publishClaims`, if present in
  the verified payload, the value is copied verbatim onto `session.user`
  (consumers do their own type coercion).

### Clerk Client Setup

Source: `packages/auth-clerk/src/client.ts`

Bridges Clerk's `getToken()` into Parcae's `AuthClientAdapter`. Works with
`@clerk/clerk-react` (web) and `@clerk/clerk-expo` (mobile).

```tsx
import { createClerkAuthAdapter } from "@parcae/auth-clerk/client";
import { ParcaeProvider } from "@parcae/sdk/react";
import { useAuth } from "@clerk/clerk-react";

function App() {
  const { getToken } = useAuth();
  const auth = useMemo(() => createClerkAuthAdapter(getToken), [getToken]);

  return (
    <ParcaeProvider url="..." auth={auth}>
      ...
    </ParcaeProvider>
  );
}
```

- `createClerkAuthAdapter(getToken, options?)` — `options.organizationId`
  (`string | null`) scopes the issued tokens; it is passed to Clerk's `getToken`.
  `init()` is a no-op (Clerk manages sessions externally). `getToken()` returns
  the token or `null` (errors become `null`). `onChange(cb)` registers a listener
  and returns an unsubscribe.
- `notifyClerkTokenChange(adapter, token)` — fires all of an adapter's
  `onChange` subscribers. Use it to propagate a Clerk sign-out or token refresh
  that happens outside React so Parcae's session machine updates.
