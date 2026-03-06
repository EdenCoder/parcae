<p align="center">
  <strong>PARCAE</strong>
</p>

<p align="center">
  <em>Nona spins the thread. Decima measures it. Morta cuts it.</em><br/>
  <em>You write the class. Parcae does the rest.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@parcae/backend"><img src="https://img.shields.io/npm/v/@parcae/backend?label=%40parcae%2Fbackend&color=161b22&labelColor=0d1117" alt="npm"></a>
  <a href="https://github.com/EdenCoder/parcae/blob/master/LICENSE"><img src="https://img.shields.io/github/license/EdenCoder/parcae?color=161b22&labelColor=0d1117" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-161b22?labelColor=0d1117" alt="node"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/typescript-strict-161b22?labelColor=0d1117" alt="typescript"></a>
</p>

---

TypeScript backend framework. Your class is the schema, the API, and the type system. One function call gives you Postgres, REST, realtime, auth, and a React SDK. No codegen, no dashboard, no vendor lock-in.

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
```

That's a running server. Tables exist. CRUD routes are live. WebSocket is ready.

## The pitch (or: why not Supabase)

Supabase is a platform. You write SQL, generate types, deploy edge functions, configure RLS policies, and hope the dashboard doesn't drift from your code. When you need a complex join, a multi-table transaction, or a background job — you're reaching outside the platform.

Parcae is the opposite. Everything is TypeScript. The class *is* the schema. The scope *is* the access rule. The hook *is* the side effect. It runs in your process, lives in your repo, and you debug it with a breakpoint.

| | Supabase | Parcae |
| --- | --- | --- |
| **Schema** | SQL migrations or dashboard | TypeScript classes. That's it. |
| **Types** | Generated from DB, always one step behind | Flow from the class. Nothing to generate. |
| **Business logic** | Edge Functions or Postgres triggers | Hooks, jobs, routes — same codebase, same types |
| **Realtime** | Postgres CDC (row-level) | Query-level subs — re-evaluates and pushes diffs |
| **Auth** | Proprietary, tied to their infra | Pluggable — Better Auth, Clerk, or roll your own |
| **Row-level security** | SQL policies (hard to test) | TypeScript scope functions (composable, testable) |
| **Background jobs** | Not built in | BullMQ with retries and backoff |
| **Lock-in** | Deep | Zero. Postgres + Redis. Swap anything. |

```typescript
// supabase: types are generated. schema lives in SQL. business logic is elsewhere.
const { data } = await supabase.from("posts").select("*").eq("published", true);

// parcae: the class IS the type IS the schema IS the API.
const posts = await Post.where({ published: true }).find();
// posts is Post[]. always.
```

## Getting started

```bash
npm install @parcae/backend @parcae/model
```

Define a model. Properties are columns.

```typescript
// models/Post.ts
import { Model } from "@parcae/model";

export class Post extends Model {
  static type = "post" as const;
  title: string = "";
  published: boolean = false;
}
```

Start the server.

```typescript
// index.ts
import { createApp } from "@parcae/backend";

const app = createApp({ models: "./models" });
await app.start();
```

```bash
DATABASE_URL=postgresql://localhost:5432/myapp node index.ts
```

```
09:41:02 INF Found 1 model(s): post
09:41:02 INF Resolved schemas for: post (cached)
09:41:02 INF Database connected
09:41:02 INF Registered 5 auto-CRUD route(s)
09:41:02 OK  Ready on port 3000 — 1 models, 6 routes, 0 hooks, 0 jobs
```

You now have:

```
GET    /v1/posts          paginated list
GET    /v1/posts/:id      single record
POST   /v1/posts          create
PUT    /v1/posts/:id      update
DELETE /v1/posts/:id      delete
PATCH  /v1/posts/:id      atomic JSON Patch (RFC 6902)
GET    /v1/health         status, uptime, model count
```

## Packages

| Package | Description |
| --- | --- |
| [`@parcae/model`](./packages/model) | Model base class, Proxy system, query builder, adapter interface |
| [`@parcae/backend`](./packages/backend) | createApp, auto-CRUD, hooks, jobs, PubSub, queue, schema resolution |
| [`@parcae/sdk`](./packages/sdk) | Client SDK — Socket.IO and SSE transports, React hooks |
| [`@parcae/auth-betterauth`](./packages/auth-betterauth) | Better Auth adapter — self-hosted, same Postgres |
| [`@parcae/auth-clerk`](./packages/auth-clerk) | Clerk adapter — external auth proxied to your User model |

## Models

A class property with a default value becomes a Postgres column. A property typed as another Model becomes a lazy-loading reference. That's the whole system.

```typescript
import { Model } from "@parcae/model";

class Post extends Model {
  static type = "post" as const;

  user!: User;                      // -> VARCHAR (foreign key, lazy-loads User)
  title: string = "";               // -> VARCHAR
  body: PostBody = { content: "" }; // -> JSONB
  tags: string[] = [];              // -> JSONB
  published: boolean = false;       // -> BOOLEAN
  views: number = 0;                // -> DOUBLE PRECISION
}
```

Direct property access. No `.get()`, no `.data.title`. Just `post.title`.

```typescript
const post = await Post.findById("abc");

post.title;         // "Hello" — typed as string
post.user;          // User proxy — loads on access, works with Suspense
post.$user;         // "user_k8f2m9x" — raw ID, no loading
post.title = "New"; // change tracked automatically

await post.save();
```

Properties not in the schema spill into an overflow `data` JSONB column. You can throw anything on a model and it persists — declared properties just get their own typed columns.

### Scopes

Scopes are row-level security in TypeScript. Any model with a `scope` gets auto-CRUD routes.

```typescript
static scope = {
  read: (ctx) => (qb) =>
    qb.where("published", true).orWhere("user", ctx.user?.id),
  create: (ctx) => (ctx.user ? { user: ctx.user.id } : null),
  update: (ctx) => (qb) => qb.where("user", ctx.user.id),
  delete: (ctx) => (qb) => qb.where("user", ctx.user.id),
};
```

Return `null` to deny. Return an object to inject defaults. Return a function to modify the query. These are real query builder callbacks — you can do OR clauses, subqueries, joins, whatever Knex supports.

### Query builder

```typescript
Post.where({ published: true }).orderBy("createdAt", "desc").limit(10).find();
Post.where("views", ">", 100).first();
Post.whereIn("id", ["a", "b", "c"]).find();
Post.count();
```

40+ chainable methods. On the backend they map to Knex. On the frontend they serialize and execute server-side.

## Routes

Express-compatible function API with middleware support.

```typescript
import { route, ok, unauthorized } from "@parcae/backend";

route.get("/v1/stats", async (req, res) => {
  const count = await Post.count();
  ok(res, { posts: count });
});

route.post("/v1/upload", requireAuth, async (req, res) => {
  if (!req.session?.user) return unauthorized(res);
  // ...
});
```

Drop files in a `controllers/` directory and they self-register on import. Like Next.js pages — just put them there.

## Hooks

Model lifecycle hooks. Before or after `save`, `create`, `update`, `patch`, `remove`.

```typescript
import { hook } from "@parcae/backend";

hook.after(Post, "save", async ({ model, enqueue }) => {
  await enqueue("post:index", { postId: model.id });
});

hook.before(Post, "create", ({ model }) => {
  model.title = model.title.trim();
});
```

Hook context gives you `model`, `lock` (distributed), `enqueue` (background jobs), and `user`.

## Jobs

BullMQ. 3 retries, exponential backoff. Requires Redis.

```typescript
import { job } from "@parcae/backend";

job("post:index", async ({ data }) => {
  const post = await Post.findById(data.postId);
  // index it somewhere
  return { indexed: true };
});
```

```typescript
import { enqueue } from "@parcae/backend";
await enqueue("post:index", { postId: post.id });
```

## Auth

Auth is a pluggable adapter. The framework itself has no opinion about your auth provider — it just needs to know who's making the request.

Your `User` model is always a real, managed Parcae model. Auth adapters resolve identity and sync user data into it. No `managed = false`, no hollow facades.

```typescript
// self-hosted — Better Auth writes directly into your users table
import { betterAuth } from "@parcae/auth-betterauth";

const app = createApp({
  models: [User, Post],
  auth: betterAuth({ providers: ["email", "google"] }),
});
```

```typescript
// external — Clerk users are proxied into your local User model
import { clerk } from "@parcae/auth-clerk";

const app = createApp({
  models: [User, Post],
  auth: clerk({
    secretKey: process.env.CLERK_SECRET_KEY!,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY!,
  }),
});
```

`req.session.user` is available in every route handler and scope. Socket.IO authenticates via the `authenticate` event. Implement the `AuthAdapter` interface to bring whatever you want.

## Client SDK

Two transports, same API. Socket.IO for bidirectional realtime, SSE for simpler infrastructure.

```typescript
import { createClient } from "@parcae/sdk";

const client = createClient({ url: "http://localhost:3000" });
// or: createClient({ url: "...", transport: "sse" })
```

The client wires up `Model.use()` automatically — `Post.where(...)` just works on the frontend.

## React

```tsx
import { ParcaeProvider, useQuery } from "@parcae/sdk/react";

function App() {
  return (
    <ParcaeProvider url="http://localhost:3000">
      <PostList />
    </ParcaeProvider>
  );
}

function PostList() {
  const { items, loading } = useQuery(
    Post.where({ published: true }).orderBy("createdAt", "desc"),
  );

  if (loading) return <p>Loading...</p>;

  return items.map((post) => (
    <article key={post.id}>
      <h2>{post.title}</h2>
      <Suspense fallback="...">
        <span>by {post.user.name}</span>
      </Suspense>
    </article>
  ));
}
```

`useQuery` is realtime. When something changes on the server, your query is re-evaluated and surgical diffs (`add`, `remove`, `update`) are pushed to the client. No polling, no refetching.

Other hooks: `useApi`, `useSDK`, `useSetting`, `useConnectionStatus`.

## Configuration

`.env` files are auto-loaded. Everything is validated at startup with Zod.

```bash
DATABASE_URL=postgresql://localhost:5432/myapp  # required
DATABASE_READ_URL=postgresql://...              # read replica (optional)
REDIS_URL=redis://localhost:6379                # PubSub + Queue (optional)
PORT=3000                                       # default: 3000
AUTH_SECRET=...                                 # required if auth enabled
BACKEND_URL=https://api.myapp.com               # for auth callbacks (optional)
FRONTEND_URL=https://myapp.com                  # (optional)
ENSURE_SCHEMA=true                              # run DDL migration on startup
```

## Project structure

```
packages/
  model/              @parcae/model       — the Model class
  backend/            @parcae/backend     — the server
  sdk/                @parcae/sdk         — the client
  auth-betterauth/    @parcae/auth-betterauth
  auth-clerk/         @parcae/auth-clerk
examples/
  basic/              working example app
```

Requires Node >= 20 and pnpm.

```bash
pnpm install && pnpm build
```

## License

MIT
