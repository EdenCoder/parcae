# Parcae

A TypeScript backend framework + client SDK. Class properties are the schema. One function to start a server. Pluggable transports.

```typescript
import { createApp } from "@parcae/backend";
import { Post } from "./models/Post";

const app = createApp({ models: [Post] });
await app.start();
```

That gives you auto-CRUD routes, Postgres persistence, realtime subscriptions, and a React-ready client SDK.

## Packages

| Package           | What                                                                          |
| ----------------- | ----------------------------------------------------------------------------- |
| `@parcae/model`   | Model base class, Proxy-based property access, adapter pattern, query builder |
| `@parcae/backend` | Server framework — createApp, auto-CRUD, hooks, jobs, auth, PubSub, Queue     |
| `@parcae/sdk`     | Client SDK — Socket.IO and SSE transports, React hooks                        |

## Models

Properties on the class are the schema. No separate column definitions.

```typescript
import { Model } from "@parcae/model";

class Post extends Model {
  static type = "post" as const;

  user!: User; // reference — VARCHAR storing ID
  title: string = ""; // string — VARCHAR
  body: PostBody; // object — JSONB
  tags: string[] = []; // array — JSONB
  published: boolean = false; // boolean — BOOLEAN
  views: number = 0; // number — INTEGER
}
```

Direct property access, fully typed:

```typescript
const post = await Post.findById("abc");
post.title; // string
post.published; // boolean
post.user; // User (lazy proxy, Suspense-compatible)
post.$user; // "user_k8f2m9x" (raw ID)
post.title = "New"; // change tracked
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
import { route } from "@parcae/backend";

route.get("/health", (req, res) => {
  res.end(JSON.stringify({ ok: true }));
});

route.post("/upload", requireAuth, rateLimit(100), (req, res) => {
  // ...
});
```

Optional class-based controllers:

```typescript
import { Controller, route } from "@parcae/backend";

class MediaController extends Controller {
  @route.post("/media/upload")
  async upload(req, res) {
    /* ... */
  }
}
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

Background job processing via BullMQ.

```typescript
import { job } from "@parcae/backend";

job("post:index", async ({ data }) => {
  const post = await Post.findById(data.postId);
  // ...
  return { success: true };
});
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

Bearer token sessions. `req.session.user` available in route handlers. Socket.IO auth via `authenticate` event.

## Client SDK

Pluggable transport layer. Same API regardless of wire protocol.

```typescript
import { createClient } from "@parcae/sdk";

// Socket.IO (default) — bidirectional, realtime
const client = createClient({ url: "http://localhost:3000" });

// SSE — HTTP + Server-Sent Events, simpler infra
const client = createClient({ url: "http://localhost:3000", transport: "sse" });

// Custom transport
const client = createClient({ url: "...", transport: myTransport });
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

Hooks: `useQuery`, `useSetting`, `useApi`, `useSDK`, `useConnectionStatus`.

## Configuration

Env vars, validated at startup with clear error messages.

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
    src/
      Model.ts            Proxy-based Model class
      adapters/
        types.ts          ModelAdapter interface, types
        client.ts         FrontendAdapter (Valtio + transport)

  backend/            @parcae/backend
    src/
      app.ts              createApp()
      config.ts           Zod-validated env config
      server.ts           Polka + Socket.IO
      auth.ts             Better Auth integration
      adapters/
        model.ts          BackendAdapter (Knex/Postgres)
        routes.ts         Auto-CRUD generator
      routing/
        route.ts          route.get/post/put/patch/delete
        hook.ts           hook.before/after
        job.ts            job()
      services/
        pubsub.ts         Redis pub/sub + distributed locking
        queue.ts          BullMQ queue + workers
        subscriptions.ts  Realtime query subscription manager
      schema/
        resolver.ts       RTTIST type → Postgres column mapping
        generate.ts       .parcae/ auto-generation pipeline

  sdk/                @parcae/sdk
    src/
      client.ts           createClient()
      transports/
        socket.ts         Socket.IO transport
        sse.ts            SSE transport
      react/
        Provider.tsx      ParcaeProvider
        context.ts        React context
        useQuery.ts       Realtime query subscriptions
        useApi.ts         useApi, useSDK, useConnectionStatus
        useSetting.ts     Key-value settings

examples/
  basic/              Minimal working app
```

## License

MIT
