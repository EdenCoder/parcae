# @parcae/backend

TypeScript backend framework. One function call bootstraps Postgres persistence, auto-CRUD routes, realtime subscriptions, background jobs, and authentication from your Model classes.

## Install

```bash
npm install @parcae/backend @parcae/model
```

## Quick Start

```typescript
import { createApp } from "@parcae/backend";

const app = createApp({ models: "./models" });
await app.start();
// -> .parcae/ generated, tables created, CRUD routes live, WebSocket ready
```

`.env` files are auto-loaded at startup:

```bash
# .env
DATABASE_URL=postgresql://localhost:5432/myapp
```

## createApp()

The main entry point. Accepts model classes directly or a directory path for auto-discovery.

```typescript
import { createApp } from "@parcae/backend";
import { User, Post } from "./models";

const app = createApp({
  models: [User, Post],       // or "./models" for auto-discovery
  controllers: "./controllers", // optional — auto-import route files
  hooks: "./hooks",             // optional — auto-import hook files
  jobs: "./jobs",               // optional — auto-import job files
  auth: {                       // optional — omit to skip auth
    providers: ["email"],
  },
  version: "v1",                // API prefix (default: "v1")
  root: process.cwd(),          // project root (default: cwd)
});

await app.start({ port: 3000, dev: true });
```

Controllers, hooks, and jobs self-register on import — just put files in the directory and they're auto-loaded (like Next.js pages).

### Startup Sequence

1. Parse and validate env config (Zod), auto-load `.env`
2. Discover models (array or directory scan)
3. Generate `.parcae/` type metadata (RTTIST)
4. Connect Postgres (Knex, optional read replica)
5. Connect Redis (PubSub + Queue, optional — falls back to in-process)
6. Create `BackendAdapter`, call `Model.use()`
7. Ensure tables exist (additive DDL migration)
8. Create HTTP server (Polka) + WebSocket server (Socket.IO)
9. Set up `QuerySubscriptionManager` for realtime
10. Mount auth middleware + routes (if configured)
11. Register auto-CRUD routes for scoped models
12. Auto-discover and import controllers, hooks, jobs
13. Start BullMQ workers + HTTP listener

### ParcaeApp

```typescript
interface ParcaeApp {
  start(options?: { dev?: boolean; port?: number }): Promise<void>;
  stop(): Promise<void>;
  schemas: Map<string, SchemaDefinition>;
  models: ModelConstructor[];
}
```

## Auto-CRUD Routes

Any model with a `scope` gets full REST endpoints automatically:

```
GET    /v1/posts          list (paginated, sortable, filterable)
GET    /v1/posts/:id      get one
POST   /v1/posts          create
PUT    /v1/posts/:id      update
DELETE /v1/posts/:id      delete
PATCH  /v1/posts/:id      atomic JSON Patch (RFC 6902)
```

### Scopes

Scopes define per-operation access control. They receive the request context and return a query modifier, a data object, or null to deny.

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

  user!: User;
  title: string = "";
  published: boolean = false;
}
```

### Query Parameters

List endpoints support:

| Parameter | Example | Description |
| --- | --- | --- |
| `limit` | `?limit=25` | Page size (max 100) |
| `page` | `?page=2` | Page number |
| `sort` | `?sort=createdAt` | Sort column |
| `direction` | `?direction=desc` | Sort direction |
| `where[field]` | `?where[published]=true` | Field filter |
| `select` | `?select=title,views` | Column selection |

## Custom Routes

Express-compatible function API. Middleware works the same way.

```typescript
import { route } from "@parcae/backend";

route.get("/v1/health", (req, res) => {
  res.end(JSON.stringify({ status: "ok" }));
});

route.post("/v1/upload", requireAuth, rateLimit(100), async (req, res) => {
  // req.session available if auth is configured
});
```

Methods: `route.get`, `route.post`, `route.put`, `route.patch`, `route.delete`, `route.options`, `route.head`, `route.all`

### Route Options

```typescript
route.get("/health", handler, { priority: 0 }); // lower = registered first
```

### Response Helpers

Convenience functions for common response patterns:

```typescript
import { json, ok, error, unauthorized, notFound, badRequest } from "@parcae/backend";

route.get("/v1/posts", async (req, res) => {
  const posts = await Post.where({ published: true }).find();
  ok(res, { posts });
});

route.get("/v1/posts/:id", async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) return notFound(res, "Post");
  ok(res, post.toJSON());
});

route.post("/v1/admin/action", async (req, res) => {
  if (!req.session?.user) return unauthorized(res);
  if (!req.body.name) return badRequest(res, "name is required");
  // ...
});
```

| Helper | Status | Body |
| --- | --- | --- |
| `json(res, status, body)` | any | raw JSON |
| `ok(res, result)` | 200 | `{ result, success: true }` |
| `error(res, status, message)` | any | `{ result: null, success: false, error }` |
| `unauthorized(res)` | 401 | `{ error: "Unauthorized" }` |
| `notFound(res, what?)` | 404 | `{ error: "{what} not found" }` |
| `badRequest(res, message)` | 400 | `{ error: message }` |

## Hooks

Model lifecycle hooks. Run before or after persistence operations.

```typescript
import { hook } from "@parcae/backend";

hook.after(Post, "save", async ({ model, lock, enqueue, user }) => {
  const unlock = await lock(`index:${model.id}`);
  try {
    await model.refresh();
    await enqueue("post:index", { postId: model.id });
  } finally {
    await unlock();
  }
});

hook.before(Post, "create", ({ model }) => {
  model.title = model.title.trim();
});
```

### Actions

`save`, `create`, `update`, `patch`, `remove`

`save` fires on both create and update. `create` and `update` fire on their respective operations only.

### Hook Context

```typescript
interface HookContext {
  model: any;
  action: HookAction;
  data?: Record<string, any>;
  user?: { id: string; [key: string]: any } | null;
  lock(key, ttl?): Promise<() => Promise<void>>;
  enqueue(name, data, opts?): Promise<boolean>;
}
```

### Hook Options

```typescript
hook.after(Post, "patch", handler, {
  async: true,    // don't block the response (default: false)
  priority: 200,  // execution order — lower runs first (default: 100)
});
```

## Jobs

Background job processing via BullMQ. Requires Redis.

```typescript
import { job } from "@parcae/backend";

job("post:index", async ({ data, bullJob, attempt }) => {
  const post = await Post.findById(data.postId);
  if (!post) return { skipped: true };
  // ... index in search engine ...
  return { success: true };
});
```

Jobs retry 3 times with exponential backoff (5s base).

### Standalone enqueue

You can enqueue jobs from anywhere — not just hook contexts:

```typescript
import { enqueue } from "@parcae/backend";

await enqueue("post:index", { postId: post.id });
await enqueue("post:index", { postId: post.id }, { jobId: `post:index:${post.id}` }); // deduped
```

## BackendAdapter

The server-side `ModelAdapter` implementation. Handles Knex/Postgres persistence, hooks, pub/sub, and the overflow column pattern.

```typescript
import { BackendAdapter } from "@parcae/backend";

const adapter = new BackendAdapter({
  read: readDb,   // Knex instance (read replica or same as write)
  write: writeDb, // Knex instance
  pubsub,         // PubSub instance (optional)
  logger,         // Winston logger (optional)
});

Model.use(adapter);
```

### Key Features

- **Upsert** — `INSERT ... ON CONFLICT MERGE` for save operations
- **Atomic JSON Patch** — Generates `jsonb_set_lax`, `jsonb_insert`, `#-` SQL for JSONB columns; direct `SET` for scalar columns
- **Overflow column** — Declared schema properties get typed columns; everything else goes into a `data` JSONB column automatically
- **Additive migration** — `ensureAllTables()` creates tables/columns/indexes if missing. Never drops.
- **Read/write splitting** — Separate Knex instances for read and write queries
- **Hook execution** — Runs registered before/after hooks during persistence operations

## PubSub

Redis-backed cross-process events. Falls back to in-process `EventEmitter` when Redis is unavailable.

```typescript
import { PubSub } from "@parcae/backend";

const pubsub = new PubSub({ url: "redis://localhost:6379" });
await pubsub.building;

pubsub.emit("post:updated", { id: "abc" });
pubsub.on("post:updated", (data) => { ... });
```

Includes distributed locking via Redlock:

```typescript
const unlock = await pubsub.lock("resource:key", 10000);
try { /* critical section */ }
finally { await unlock(); }
```

### Standalone lock

```typescript
import { lock } from "@parcae/backend";

const unlock = await lock("resource:abc", 120000);
try { /* exclusive access */ }
finally { await unlock(); }
```

## Queue

BullMQ queue management. Falls back gracefully when Redis is unavailable.

```typescript
import { QueueService, addJobIfNotExists } from "@parcae/backend";

const queue = new QueueService({ url: "redis://localhost:6379" });
await queue.building;

await addJobIfNotExists(queue.get(), "post:index", { postId: "abc" });
```

## QuerySubscriptionManager

Manages realtime query subscriptions for connected clients. When a model changes, affected queries are re-evaluated and surgical diff ops (`add`, `remove`, `update`) are pushed to subscribers.

## Auth

Opt-in authentication via Better Auth. Email/password + OAuth providers.

```typescript
const app = createApp({
  models: [User, Post],
  auth: {
    providers: ["email", "google", "github"],
    google: { clientId: "...", clientSecret: "..." },
    session: { expiresIn: 60 * 60 * 24 * 7 },
    basePath: "/v1/auth",
  },
});
```

- Bearer token sessions resolved on all HTTP requests (`req.session`)
- Socket.IO auth via `authenticate` event
- Better Auth handler mounted at `/v1/auth/*`

## Schema Generation

At startup, `createApp()` generates type metadata into `.parcae/` (gitignored, like `.next/`):

1. Runs RTTIST typegen to extract TypeScript type metadata
2. `SchemaResolver` maps types to column definitions
3. Falls back to default-value inference if RTTIST is unavailable
4. Caches resolved schemas to `.parcae/schema.json`

## Configuration

Environment variables validated at startup via Zod. `.env` files are auto-loaded.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | -- | PostgreSQL connection string |
| `DATABASE_READ_URL` | No | -- | Read replica connection string |
| `REDIS_URL` | No | -- | Redis for PubSub + Queue |
| `PORT` | No | `3000` | HTTP server port |
| `AUTH_SECRET` | No | -- | Session signing secret (required if auth enabled) |
| `TRUSTED_ORIGINS` | No | -- | Comma-separated CORS origins |
| `NODE_ENV` | No | `development` | `development` / `production` / `test` |
| `SERVER` | No | `true` | Run HTTP + WebSocket server |
| `DAEMON` | No | `false` | Run background workers |

## Exports

```typescript
// App
import { createApp } from "@parcae/backend";
import type { ParcaeApp, AppConfig } from "@parcae/backend";

// Adapter
import { BackendAdapter, registerModelRoutes } from "@parcae/backend";
import type { BackendServices } from "@parcae/backend";

// Routing
import { route, Controller, hook, job } from "@parcae/backend";
import type {
  RouteHandler, Middleware, RouteOptions, RouteEntry,
  HookContext, HookOptions, HookEntry,
  JobHandler, JobContext, JobEntry,
} from "@parcae/backend";

// Response helpers
import { json, ok, error, unauthorized, notFound, badRequest } from "@parcae/backend";

// Services
import { PubSub, QueueService, addJobIfNotExists, QuerySubscriptionManager } from "@parcae/backend";
import { enqueue, lock, getQueue, getPubSub } from "@parcae/backend";
import type { PubSubConfig, QueueConfig, EnqueueOptions } from "@parcae/backend";

// Auth
import { createAuth, createAuthMiddleware, createSocketAuthHandler } from "@parcae/backend";
import type { AuthConfig, AuthInstance, Session } from "@parcae/backend";

// Schema
import { SchemaResolver, resolveFallbackSchema, generateSchemas, loadCachedSchemas } from "@parcae/backend";

// Config
import { parseConfig, configSchema } from "@parcae/backend";
import type { Config } from "@parcae/backend";

// Registry utilities
import { getRoutes, clearRoutes, getHooks, getHooksFor, clearHooks, getJobs, getJob, clearJobs } from "@parcae/backend";

// Convenience re-export
import { Model } from "@parcae/backend";
```

## License

MIT
