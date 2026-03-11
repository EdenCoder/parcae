# @parcae/auth-betterauth

Better Auth adapter for Parcae. Self-hosted authentication that uses your User Model as the users table.

## Install

```bash
npm install @parcae/auth-betterauth
```

Requires `@parcae/backend` and `@parcae/model` as peer dependencies.

## Usage

```typescript
import { createApp } from "@parcae/backend";
import { betterAuth } from "@parcae/auth-betterauth";
import { User } from "./models/User";
import { Post } from "./models/Post";

const app = createApp({
  models: [User, Post],
  auth: betterAuth({
    providers: ["email", "google"],
    google: { clientId: "...", clientSecret: "..." },
  }),
});

await app.start();
```

## User Model

The User Model is a real, managed Parcae Model. Better Auth writes auth fields (`email`, `name`, `image`, `emailVerified`) into the same table. Your custom fields live alongside them.

```typescript
import { Model } from "@parcae/model";

class User extends Model {
  static type = "user" as const;

  // Auth-synced fields (written by Better Auth)
  name: string = "";
  email: string = "";
  emailVerified: boolean = false;
  image?: string;

  // Your custom fields
  bio: string = "";
  role: "user" | "admin" = "user";
  plan: "free" | "pro" = "free";
}
```

No `managed = false`. One table, one Model, one source of truth.

## How It Works

- **`setup()`** — Creates the Better Auth instance using your Postgres connection. Points Better Auth at your User model's table. Creates `sessions`, `accounts`, `verifications` tables internally. Uses Parcae's `generateId()` for ID generation.
- **`resolveRequest()`** — Calls `auth.api.getSession(headers)` to resolve the session from HTTP headers.
- **`resolveToken()`** — Same, for Socket.IO auth via Bearer token.
- **`routes`** — Mounts Better Auth's handler at `/v1/auth/*` (configurable via `basePath`).

## Configuration

```typescript
betterAuth({
  // Auth providers. Default: ["email"]
  providers: ["email", "google", "github"],

  // OAuth config (required if using social providers)
  google: { clientId: "...", clientSecret: "..." },
  github: { clientId: "...", clientSecret: "..." },

  // Session config
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days (default)
    updateAge: 60 * 60 * 24, // refresh daily (default)
  },

  // Additional trusted origins (added to TRUSTED_ORIGINS env var)
  trustedOrigins: ["https://myapp.com"],

  // Auth route prefix. Default: "/v1/auth"
  basePath: "/v1/auth",

  // Base URL for OAuth callbacks. Auto-detected from PORT if not set.
  baseURL: "https://api.myapp.com",
});
```

## Environment Variables

| Variable          | Required | Description                                |
| ----------------- | -------- | ------------------------------------------ |
| `AUTH_SECRET`     | Yes      | Secret for session signing                 |
| `DATABASE_URL`    | Yes      | PostgreSQL connection (shared with Parcae) |
| `TRUSTED_ORIGINS` | No       | Additional CORS origins                    |

## License

MIT
