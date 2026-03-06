# Parcae

A TypeScript backend framework where your class **is** the API.

Define a class. Get a database, REST endpoints, realtime subscriptions, auth, and a typed React SDK. No dashboard, no code generation, no vendor lock-in — just your code and Postgres.

```typescript
class Post extends Model {
  static type = "post" as const;
  user!: User;
  title: string = "";
  published: boolean = false;
  views: number = 0;
}

const app = createApp({ models: [Post] });
await app.start();
// -> Tables exist. CRUD routes live. WebSocket ready. Go.
```

## Why Not Supabase?

Supabase gives you a Postgres database and auto-generates a REST API from the schema. That works — until it doesn't.

| | Supabase | Parcae |
| --- | --- | --- |
| **Schema source of truth** | SQL migrations or their dashboard | TypeScript classes — your code IS the schema |
| **Type safety** | Generated types from DB, always one step behind | Types flow from the class definition. Nothing to generate or sync. |
| **Business logic** | Edge Functions (separate runtime, separate deploy) or Postgres functions (SQL) | Hooks, jobs, routes — same codebase, same process, same types |
| **Realtime** | Postgres CDC (row-level, channel-based) | Query-level subscriptions — server re-evaluates your query and pushes diffs |
| **Auth** | Supabase Auth (proprietary, tied to their infra) | Better Auth (open source, self-hosted, same database) |
| **Row-level security** | Postgres RLS policies (SQL, hard to test, easy to misconfigure) | Scope functions in TypeScript — composable, testable, debuggable |
| **Client SDK** | `supabase-js` (query builder that generates PostgREST calls) | Typed Model classes with `useQuery()` — same class on client and server |
| **Background jobs** | None built-in (need separate infra) | BullMQ — `job("post:index", handler)`, retries, backoff, built in |
| **Hosting** | Their cloud or self-host their entire stack | Your server. Any host. It's a Node process. |
| **Vendor lock-in** | Deep (auth, storage, edge functions, realtime all coupled) | None. Postgres + Redis. Swap any piece. |

### The real difference

Supabase is a platform. You build around their abstractions — their auth, their client, their dashboard, their edge functions. When you hit a wall (complex joins, transactions across tables, custom auth flows, background processing), you're reaching outside the platform.

Parcae is a framework. Your TypeScript code is the system. The class defines the schema. The scope defines the access rules. The hook runs the side effects. The job processes the background work. It all lives in your repo, runs in your process, and you can debug it with `console.log`.

```typescript
// Supabase: schema lives in SQL, types are generated, business logic is somewhere else
const { data } = await supabase.from("posts").select("*").eq("published", true);
// What type is `data`? Whatever the codegen says. Hope it's current.

// Parcae: the class IS the schema, IS the type, IS the API
const posts = await Post.where({ published: true }).find();
// posts is Post[]. Always. The class is the source of truth.
```

```typescript
// Supabase: side effects need an Edge Function (separate deploy, separate runtime)
// Or a Postgres trigger (SQL, no access to your app logic)

// Parcae: hook runs in your process, has access to everything
hook.after(Post, "save", async ({ model, enqueue }) => {
  await enqueue("post:index", { id: model.id });
});
```

```typescript
// Supabase RLS: SQL policy, hard to unit test
// CREATE POLICY "users can update own posts" ON posts
//   FOR UPDATE USING (auth.uid() = user_id);

// Parcae scope: TypeScript function, easy to test and compose
static scope = {
  update: (ctx) => (qb) => qb.where("user", ctx.user.id),
};
```

## Quick Start

```bash
mkdir my-app && cd my-app
npm init -y
npm install @parcae/backend @parcae/model
```

```typescript
// models/Post.ts
import { Model } from "@parcae/model";

class Post extends Model {
  static type = "post" as const;
  title: string = "";
  published: boolean = false;
}
export { Post };
```

```typescript
// index.ts
import { createApp } from "@parcae/backend";
const app = createApp({ models: "./models" });
await app.start();
```

```bash
# .env (auto-loaded)
DATABASE_URL=postgresql://localhost:5432/myapp
```

```bash
node index.ts
# -> .parcae/ generated
# -> Tables created
# -> CRUD routes live at /v1/posts
# -> WebSocket ready on port 3000
```

## Packages

| Package | What |
| --- | --- |
| [`@parcae/model`](./packages/model) | Model base class, Proxy-based property access, adapter pattern, query builder |
| [`@parcae/backend`](./packages/backend) | Server framework — createApp, auto-CRUD, hooks, jobs, auth, PubSub, Queue |
| [`@parcae/sdk`](./packages/sdk) | Client SDK — Socket.IO and SSE transports, React hooks |

## Models

Properties on the class are the schema. No separate column definitions.

```typescript
import { Model } from "@parcae/model";

class Post extends Model {
  static type = "post" as const;

  user!: User;                    // reference — VARCHAR storing ID
  title: string = "";             // string — VARCHAR
  body: PostBody = { content: "" }; // object — JSONB
  tags: string[] = [];            // array — JSONB
  published: boolean = false;     // boolean — BOOLEAN
  views: number = 0;              // number — DOUBLE PRECISION
}
```

Direct property access, fully typed:

```typescript
const post = await Post.findById("abc");
post.title;              // string
post.published;          // boolean
post.user;               // User (lazy proxy, Suspense-compatible)
post.$user;              // "user_k8f2m9x" (raw ID)
post.title = "New";      // change tracked
await post.save();
```

Scoped access control:

```typescript
class Post extends Model {
  static type = "post" as const;

  static scope = {
    read: (ctx) => (qb) =>
      qb.where("published", true).orWhere("user", ctx.user?.id),
    create: (ctx) => (ctx.user ? { user: ctx.user.id } : null),
    update: (ctx) => (qb) => qb.where("user", ctx.user.id),
    delete: (ctx) => (qb) => qb.where("user", ctx.user.id),
  };

  // ...
}
```

Any model with a `scope` gets full CRUD routes automatically:

```
GET    /v1/posts          list (paginated, sortable, filterable)
GET    /v1/posts/:id      get one
POST   /v1/posts          create
PUT    /v1/posts/:id      update
DELETE /v1/posts/:id      delete
PATCH  /v1/posts/:id      atomic JSON Patch (RFC 6902)
```

## Routes

Express-compatible. Middleware works the same way.

```typescript
import { route, ok, unauthorized } from "@parcae/backend";

route.get("/v1/health", (req, res) => {
  ok(res, { status: "healthy" });
});

route.post("/v1/upload", requireAuth, async (req, res) => {
  if (!req.session?.user) return unauthorized(res);
  // ...
});
```

## Hooks

Model lifecycle hooks. Run before or after save, patch, remove, create, update.

```typescript
import { hook } from "@parcae/backend";

hook.after(Post, "save", async ({ model, lock, enqueue }) => {
  const unlock = await lock(`index:${model.id}`);
  try {
    await model.refresh();
    await enqueue("post:index", { postId: model.id });
  } finally {
    await unlock();
  }
});

hook.before(Post, "remove", async ({ model }) => {
  // cleanup
});
```

## Jobs

Background job processing via BullMQ. 3 retries with exponential backoff.

```typescript
import { job } from "@parcae/backend";

job("post:index", async ({ data }) => {
  const post = await Post.findById(data.postId);
  // ...
  return { success: true };
});
```

Enqueue from anywhere:

```typescript
import { enqueue } from "@parcae/backend";

await enqueue("post:index", { postId: post.id });
```

## Auth

Opt-in Better Auth integration. Email/password + OAuth.

```typescript
const app = createApp({
  models: [Post],
  auth: {
    providers: ["email", "google", "github"],
    google: { clientId: "...", clientSecret: "..." },
  },
});
```

Bearer token sessions. `req.session.user` in route handlers. Socket.IO auth via `authenticate` event.

## Client SDK

Pluggable transport layer. Same API regardless of wire protocol.

```typescript
import { createClient } from "@parcae/sdk";

// Socket.IO (default) — bidirectional, realtime
const client = createClient({ url: "http://localhost:3000" });

// SSE — HTTP + Server-Sent Events, simpler infra
const client = createClient({ url: "http://localhost:3000", transport: "sse" });
```

## React

```tsx
import { ParcaeProvider, useQuery, useSetting } from "@parcae/sdk/react";

<ParcaeProvider client={client}>
  <App />
</ParcaeProvider>;

function PostList() {
  const { items, loading } = useQuery(
    Post.where({ published: true }).orderBy("createdAt", "desc"),
  );

  return items.map((post) => (
    <article key={post.id}>
      <h2>{post.title}</h2>
      <Suspense fallback="...">
        <span>{post.user.name}</span>
      </Suspense>
    </article>
  ));
}
```

`useQuery` subscribes to realtime updates. When a model changes on the server, your query is re-evaluated and surgical diffs are pushed to the client. No polling, no refetching, no stale data.

Hooks: `useQuery`, `useSetting`, `useApi`, `useSDK`, `useConnectionStatus`.

## Configuration

Env vars, validated at startup. `.env` files auto-loaded.

```bash
DATABASE_URL=postgresql://localhost:5432/myapp    # required
DATABASE_READ_URL=postgresql://...                # optional read replica
REDIS_URL=redis://localhost:6379                  # optional (PubSub + Queue)
AUTH_SECRET=...                                   # required if auth enabled
PORT=3000                                         # optional
```

## Project Structure

```
packages/
  model/              @parcae/model
  backend/            @parcae/backend
  sdk/                @parcae/sdk
examples/
  basic/              Minimal working app
```

Requirements: Node >= 20, pnpm

```bash
pnpm install
pnpm build
```

## License

MIT
