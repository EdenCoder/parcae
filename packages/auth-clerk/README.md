# @parcae/auth-clerk

Clerk adapter for Parcae. External authentication with user data proxied to your local User model.

## Install

```bash
npm install @parcae/auth-clerk
```

Requires `@parcae/backend` and `@parcae/model` as peer dependencies.

## Usage

```typescript
import { createApp } from "@parcae/backend";
import { clerk } from "@parcae/auth-clerk";
import { User } from "./models/User";
import { Post } from "./models/Post";

const app = createApp({
  models: [User, Post],
  auth: clerk({
    secretKey: process.env.CLERK_SECRET_KEY!,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY!,
    webhookSecret: process.env.CLERK_WEBHOOK_SECRET, // optional
  }),
});

await app.start();
```

## User Model

The User Model is a real, managed Parcae Model. Clerk user data is proxied into it.

```typescript
import { Model } from "@parcae/model";

class User extends Model {
  static type = "user" as const;

  // Synced from Clerk (via proxy on first request or webhook)
  name: string = "";
  email: string = "";
  image?: string;

  // Your custom fields
  bio: string = "";
  role: "user" | "admin" = "user";
}
```

`post.user` resolves to a real `User` instance from your Postgres database. The Clerk user ID becomes the local User ID.

## How It Works

### First-request proxy

When a Clerk-authenticated request comes in:

1. The adapter verifies the session token using `@clerk/backend`
2. Looks up the Clerk user ID in your local `users` table
3. If not found, fetches the user from Clerk's API and creates a local record
4. Returns the session with the local user ID

### Webhook sync (optional)

If `webhookSecret` is provided, the adapter mounts a webhook endpoint that handles:

- `user.created` — creates a local User record
- `user.updated` — updates the local User record
- `user.deleted` — removes the local User record

Webhooks are verified using Svix (Clerk's webhook delivery system).

### Custom user mapping

Override how Clerk user data maps to your Model:

```typescript
clerk({
  secretKey: "...",
  publishableKey: "...",
  mapUser: (clerkUser) => ({
    name: `${clerkUser.firstName} ${clerkUser.lastName}`,
    email: clerkUser.emailAddresses[0]?.emailAddress ?? "",
    image: clerkUser.imageUrl,
    // Map any Clerk field to your Model's fields
  }),
})
```

## Configuration

```typescript
clerk({
  // Required
  secretKey: process.env.CLERK_SECRET_KEY!,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY!,

  // Optional — enables webhook sync
  webhookSecret: process.env.CLERK_WEBHOOK_SECRET,

  // Webhook route path. Default: "/webhooks/clerk"
  webhookPath: "/webhooks/clerk",

  // Custom Clerk → User mapping
  mapUser: (clerkUser) => ({ ... }),
})
```

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `CLERK_SECRET_KEY` | Yes | Clerk secret key (sk_...) |
| `CLERK_PUBLISHABLE_KEY` | Yes | Clerk publishable key (pk_...) |
| `CLERK_WEBHOOK_SECRET` | No | Svix webhook signing secret (whsec_...) |

## License

MIT
