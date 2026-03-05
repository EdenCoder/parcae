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
// -> .parcae/ generated
// -> Tables created
// -> CRUD routes live
// -> WebSocket ready
```

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

### Startup Sequence

1. Parse and validate env config (Zod)
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
12. Register custom routes, hooks, jobs
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
| `limit` | `?limit=25` | Page size |
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

### Controller Class

Optional class-based alternative:

```typescript
import { Controller, route } from "@parcae/backend";

class MediaController extends Controller {
  @route.post("/v1/media/upload")
  async upload(req, res) {
    // ...
  }
}
```

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
  model: any;                   // the model instance
  action: HookAction;          // which action triggered this hook
  data?: Record<string, any>;  // raw request data
  lock(key, ttl?): Promise<() => Promise<void>>; // distributed lock
  enqueue(name, data, opts?): Promise<void>;      // queue a background job
  user?: { id: string };       // authenticated user
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

Jobs retry 3 times with exponential backoff (5s base). Enqueue from hooks or anywhere:

```typescript
await enqueue("post:index", { postId: post.id });
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

pubsub.publish("post:updated", { id: "abc" });
pubsub.subscribe("post:updated", (data) => { ... });
```

Includes distributed locking via Redlock:

```typescript
const unlock = await pubsub.lock("resource:key", 10000);
try { /* critical section */ }
finally { await unlock(); }
```

## Queue

BullMQ queue management. Falls back gracefully when Redis is unavailable.

```typescript
import { QueueService, addJobIfNotExists } from "@parcae/backend";

const queue = new QueueService({ url: "redis://localhost:6379" });
await queue.building;

// Add a job (deduped by ID)
await addJobIfNotExists(queue.get(), "post:index", { postId: "abc" });
```

## QuerySubscriptionManager

Manages realtime query subscriptions for connected clients. When a model changes, affected queries are re-evaluated and surgical diff ops (`add`, `remove`, `update`) are pushed to subscribers.

```typescript
import { QuerySubscriptionManager } from "@parcae/backend";

const subs = new QuerySubscriptionManager(adapter, (socketId, event, data) => {
  io.to(socketId).emit(event, data);
});

// Called automatically by BackendAdapter on model changes
subs.onModelChange("post");
```

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

Environment variables validated at startup via Zod:

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
import { BackendAdapter } from "@parcae/backend";
import type { BackendServices } from "@parcae/backend";

// Routing
import { route, Controller, hook, job } from "@parcae/backend";
import type { RouteHandler, Middleware, HookContext, JobContext } from "@parcae/backend";

// Services
import { PubSub, QueueService, QuerySubscriptionManager } from "@parcae/backend";

// Auth
import { createAuth, createAuthMiddleware } from "@parcae/backend";
import type { AuthConfig, Session } from "@parcae/backend";

// Schema
import { SchemaResolver, generateSchemas } from "@parcae/backend";

// Config
import { parseConfig, configSchema } from "@parcae/backend";
import type { Config } from "@parcae/backend";

// Convenience re-export
import { Model } from "@parcae/backend";
```

## License

MIT
