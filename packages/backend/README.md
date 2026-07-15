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
// -> .parcae/ generated, Postgres connected, CRUD + WebSocket ready
```

`.env` files are auto-loaded at startup. Enable schema management for the first deploy or a dedicated migration step:

```bash
# .env
DATABASE_URL=postgresql://localhost:5432/myapp
ENSURE_SCHEMA=true
```

Later API boots should omit `ENSURE_SCHEMA`: they perform no DDL and verify that the required realtime triggers are already installed.

## createApp()

The main entry point. Accepts model classes directly or a directory path for auto-discovery.

```typescript
import { createApp } from "@parcae/backend";
import { User, Post } from "./models";

const app = createApp({
  models: [User, Post], // or "./models" for auto-discovery
  migrations: "./migrations", // optional — schema/data migrations
  controllers: "./controllers", // optional — auto-import route files
  hooks: "./hooks", // optional — auto-import hook files
  jobs: "./jobs", // optional — auto-import job files
  auth: {
    // optional — omit to skip auth
    providers: ["email"],
  },
  version: "v1", // API prefix (default: "v1")
  root: process.cwd(), // project root (default: cwd)
});

await app.start({ port: 3000, dev: true });
```

Controllers, hooks, and jobs self-register on import — just put files in the directory and they're auto-loaded (like Next.js pages).

### Startup Sequence

1. Parse and validate env config (Zod), auto-load `.env`
2. Discover models and registered migrations
3. Generate `.parcae/` type metadata (ts-morph schema resolver)
4. Connect the Postgres primary and optional ordinary-read replica
5. Connect Redis for application events, locks, and queues (optional — local fallback)
6. Bind the `BackendAdapter` and set up auth
7. With `ENSURE_SCHEMA=true`, run migrations, ensure the additive model schema, and install realtime triggers
8. Without `ENSURE_SCHEMA`, verify realtime triggers with read-only catalog queries before an API process starts
9. Create Polka + Socket.IO, the `QuerySubscriptionManager`, and one Postgres `LISTEN` connection per API process
10. Register routes, hooks, jobs, and crons; then start selected workers and the HTTP listener

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
import { Model, type Ref } from "@parcae/model";

class Post extends Model {
  static type = "post" as const;

  static scope = {
    read: (ctx) => (qb) =>
      qb.where("published", true).orWhere("user", ctx.user?.id),
    create: (ctx) => (ctx.user ? { user: ctx.user.id } : null),
    update: (ctx) => (qb) => qb.where("user", ctx.user.id),
    delete: (ctx) => (qb) => qb.where("user", ctx.user.id),
  };

  user!: Ref<User>;
  title: string = "";
  published: boolean = false;
}
```

### Query Parameters

List endpoints support:

| Parameter      | Example                  | Description         |
| -------------- | ------------------------ | ------------------- |
| `limit`        | `?limit=25`              | Page size (max 100) |
| `page`         | `?page=2`                | Page number         |
| `sort`         | `?sort=createdAt`        | Sort column         |
| `direction`    | `?direction=desc`        | Sort direction      |
| `where[field]` | `?where[published]=true` | Field filter        |
| `select`       | `?select=title,views`    | Column selection    |

## Custom Routes

Express-compatible function API. Middleware works the same way.

```typescript
import { route } from "@parcae/backend";

route.get("/v1/health", (req, res) => {
  res.end(JSON.stringify({ status: "ok" }));
});

route.post("/v1/upload", auditLogMiddleware, rateLimiter, async (req, res) => {
  // req.session available if auth is configured; use ok(res, …) to respond
});
```

### App Middleware

Use `createApp({ middleware: [...] })` for middleware that should apply to
health checks, auto-CRUD, custom routes, and socket RPC. Middleware is mounted
after auth/session resolution and before routes.

```typescript
import { createApp } from "@parcae/backend";

createApp({
  models: [User, Post],
  middleware: [
    (req, _res, next) => {
      req.requestId = crypto.randomUUID();
      next();
    },
  ],
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
import {
  json,
  ok,
  error,
  unauthorized,
  notFound,
  badRequest,
} from "@parcae/backend";

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

| Helper                        | Status | Body                                      |
| ----------------------------- | ------ | ----------------------------------------- |
| `json(res, status, body)`     | any    | raw JSON                                  |
| `ok(res, result)`             | 200    | `{ result, success: true }`               |
| `error(res, status, message)` | any    | `{ result: null, success: false, error }` |
| `unauthorized(res)`           | 401    | `{ error: "Unauthorized" }`               |
| `notFound(res, what?)`        | 404    | `{ error: "{what} not found" }`           |
| `badRequest(res, message)`    | 400    | `{ error: message }`                      |

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
  enqueue(name, data, opts?): Promise<Job | false | null>;
  onError(fn: () => Promise<void> | void): void;
}
```

`enqueue` returns the BullMQ `Job` if added, `null` if deduped by `jobId`, or `false` if no queue is configured (REDIS_URL not set). `onError` registers a compensating cleanup that runs in LIFO order if any later before-hook, the DB write, or an after-hook throws — use it to roll back external side effects (Clerk users, S3 uploads, Stripe subscriptions).

### Hook Options

```typescript
hook.after(Post, "patch", handler, {
  async: true, // don't block the response (default: false)
  priority: 200, // execution order — lower runs first (default: 100)
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
await enqueue(
  "post:index",
  { postId: post.id },
  { jobId: `post:index:${post.id}` },
); // deduped
```

## BackendAdapter

The server-side `ModelAdapter` implementation. Handles Knex/Postgres persistence, hooks, subscriptions, and the overflow column pattern.

```typescript
import { BackendAdapter } from "@parcae/backend";

const adapter = new BackendAdapter({
  read: readDb, // Knex instance (read replica or same as write)
  write: writeDb, // Knex instance
});

Model.use(adapter); // one-time application binding; use Model.bind() for other contexts
```

### Key Features

- **Atomic save** — New rows use `INSERT ... ON CONFLICT`; existing rows lock and patch the current row from the model's last server snapshot, preserving unrelated concurrent JSONB edits and rejecting unsafe array conflicts with `409`
- **Atomic JSON Patch** — Generates `jsonb_set_lax`, `jsonb_insert`, `#-` SQL for JSONB columns; direct `SET` for scalar columns
- **Overflow column** — Declared schema properties get typed columns; everything else goes into a `data` JSONB column automatically
- **Additive schema** — `ensureAllTables()` creates missing tables, columns, indexes, and realtime triggers when schema management is enabled
- **Read/write splitting** — Ordinary reads may use a replica; subscription rows, counts, and expansions read the primary to stay consistent with notifications
- **Hook execution** — Runs registered before/after hooks during persistence operations; after-hooks receive the authoritative persisted state

## Schema and Migrations

Pass a migrations directory to `createApp()` to discover files that self-register with `migration()`:

```typescript
const app = createApp({
  models: "./models",
  migrations: "./migrations",
});
```

`ENSURE_SCHEMA=true` makes startup run registered migrations, `ensureAllTables()`, and versioned realtime-trigger installation. A normal `RUN_SERVER=true` boot without the flag performs read-only catalog verification and fails if any managed table is missing the expected trigger.

Migrations run lexicographically before the additive schema pass, use transactions by default, and share Knex's cross-process migration lock. State lives in `parcae_migrations`; checksum, description, ticket, duration, and effect metadata live in `parcae_migration_meta`.

**Applied migration files are immutable and permanent.** Never edit one after application, and never delete it while its name remains in `parcae_migrations`. Edit drift throws `MigrationChecksumError`; a missing file makes Knex treat the migration directory as corrupt. Restore the original file and add a new compensating migration. The `--allow-checksum-drift` CLI flag and `PARCAE_ALLOW_CHECKSUM_DRIFT=true` startup variable are emergency, audit-visible bypasses only.

The CLI manages registered migration files only. Automatic model columns, indexes, and realtime triggers still require an app schema step with `ENSURE_SCHEMA=true`.

```bash
npx parcae migrate:make add-post-slug
npx parcae migrate:list
npx parcae migrate:status
npx parcae migrate:latest
```

## PubSub

Redis-backed cross-process application events. Falls back to an in-process `EventEmitter` when Redis is unavailable. Realtime model changes do not use this service.

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
try {
  /* critical section */
} finally {
  await unlock();
}
```

### Standalone lock

```typescript
import { lock } from "@parcae/backend";

const unlock = await lock("resource:abc", 120000);
try {
  /* exclusive access */
} finally {
  await unlock();
}
```

## Queue

BullMQ queue management. Falls back gracefully when Redis is unavailable.

```typescript
import { QueueService, addJobIfNotExists } from "@parcae/backend";

const queue = new QueueService({ url: "redis://localhost:6379" });
await queue.building;

await addJobIfNotExists(queue.get(), "post:index", { postId: "abc" });
```

## Realtime Subscriptions

Postgres `AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW` triggers publish compact notifications only after commit. Every API process owns one dedicated `LISTEN parcae_change` connection and forwards changes to its local `QuerySubscriptionManager`; Redis and adapter-side duplicate events are not involved.

The manager caches each scoped query once, shares it across subscribed sockets, and executes subscription rows, counts, and expansions on the primary. Safe updates fetch only the changed row or referenced expansion. Inserts, deletes, membership/order uncertainty, and reconnect reconciliation use a full scoped query. Both paths emit surgical diff ops (`add`, `remove`, `update`).

## Auth

Auth is pluggable via the `AuthAdapter` interface. The framework doesn't ship with any auth provider — install the one you need:

| Package                   | Provider    | Users live...                                    |
| ------------------------- | ----------- | ------------------------------------------------ |
| `@parcae/auth-betterauth` | Better Auth | In your Postgres (same table as your User model) |
| `@parcae/auth-clerk`      | Clerk       | In Clerk's cloud (proxied to your User model)    |

```typescript
import { betterAuth } from "@parcae/auth-betterauth";

const app = createApp({
  models: [User, Post],
  auth: betterAuth({ providers: ["email", "google"] }),
});
```

```typescript
import { clerk } from "@parcae/auth-clerk";

const app = createApp({
  models: [User, Post],
  auth: clerk({
    secretKey: process.env.CLERK_SECRET_KEY!,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY!,
  }),
});
```

The `User` Model is always a real, managed Parcae Model. Auth adapters resolve identity and sync user data into it.

- `req.session.user` available in route handlers and scopes
- Socket.IO auth via one `hello` token handshake per connection/reconnect
- Implement `AuthAdapter` to bring your own provider

## Schema Generation

At startup, `createApp()` generates type metadata into `.parcae/` (gitignored, like `.next/`):

1. Runs the ts-morph schema resolver to extract TypeScript type metadata
2. `SchemaResolver` maps types to column definitions
3. Falls back to default-value inference if a type can't be resolved
4. Caches resolved schemas to `.parcae/schema.json`

## Configuration

`.env` files are auto-loaded at startup; core configuration is validated with Zod.

| Variable                          | Required | Default       | Description                                       |
| --------------------------------- | -------- | ------------- | ------------------------------------------------- |
| `DATABASE_URL`                    | Yes      | --            | PostgreSQL connection string                      |
| `DATABASE_READ_URL`               | No       | --            | Read replica connection string                    |
| `REDIS_URL`                       | No       | --            | Redis for app events, locks, and queues           |
| `PORT`                            | No       | `3000`        | HTTP server port                                  |
| `AUTH_SECRET`                     | No       | --            | Session signing secret (required if auth enabled) |
| `TRUSTED_ORIGINS`                 | No       | --            | Comma-separated CORS origins                      |
| `NODE_ENV`                        | No       | `development` | `development` / `production` / `test`             |
| `RUN_SERVER`                      | No       | `true`        | Register CRUD / custom routes / Socket.IO         |
| `RUN_HOOKS`                       | No       | `true`        | Run model lifecycle hooks                         |
| `RUN_JOBS`                        | No       | `false`       | `true` / `false` / `"name1,name2"` (workers)      |
| `RUN_CRONS`                       | No       | follows JOBS  | `true` / `false` / `"name1,name2"` (schedulers)   |
| `ENSURE_SCHEMA`                   | No       | `false`       | Run migrations, additive schema, and trigger DDL  |
| `PARCAE_ALLOW_CHECKSUM_DRIFT`     | No       | `false`       | Emergency bypass for applied-migration drift      |

### Process roles

The four `RUN_*` flags compose to give you useful process shapes:

| Role            | `RUN_SERVER` | `RUN_HOOKS` | `RUN_JOBS` | `RUN_CRONS` | Use case                                     |
| --------------- | ------------ | ----------- | ---------- | ----------- | -------------------------------------------- |
| All-in-one      | `true`       | `true`      | `true`     | `true`      | Dev, single-process deploys                  |
| API only        | `true`       | `true`      | `false`    | `false`     | Stateless HTTP/Socket.IO front-end           |
| Worker only     | `false`      | `true`      | `true`     | `true`      | Dedicated BullMQ consumer + cron host        |
| Named workers   | `false`      | `true`      | `panel,…`  | `false`     | Per-job-fleet routing (GPU, mailer, etc.)    |
| Cron host       | `false`      | `true`      | `false`    | `true`      | Tiny process that only fires scheduled tasks |

`RUN_CRONS` defaults to follow `RUN_JOBS` (any process running jobs also
schedules every cron). `/<version>/health` is always served regardless
of `RUN_SERVER`, so the worker process can still satisfy Cloud Run / k8s
probes.

### Per-job-name queues

Each registered job is enqueued into its own BullMQ queue, named
`${defaultName}-${jobName}` (e.g. `parcae-panel`, `parcae-post.index`).
Colons in either component are collapsed to dashes because BullMQ v5
rejects colons in queue names — the job-side identifier (`post:index`)
keeps its original shape; only the derived queue name is sanitised.
Workers subscribe to specific queues, so an operator can split workloads
across machines without each worker pulling jobs it can't handle:

```
RUN_JOBS=true              # subscribe to every registered job's queue
RUN_JOBS=panel,image       # only handle panel + image jobs on this fleet
RUN_JOBS=false             # don't process any jobs (enqueue still works)
```

Each worker uses its own per-job `concurrency` from
`job(name, handler, { concurrency })`. **Total in-flight work is the
sum of opted-in concurrencies**, not the max — that was the
pre-routing footgun. So a worker with `panel=16 image=32 voice=32` is
running up to **80** concurrent BullMQ jobs, not 32.

Unknown names in `RUN_JOBS` (typos) log a warning at startup but don't
hard-fail — useful when staged rollouts mean a job hasn't been
registered yet in this version.

> ⚠️ **Hard cutover from pre-routing versions.** No worker subscribes to
> the bare `${defaultName}` queue any more. If you're upgrading across
> this boundary, drain any in-flight legacy jobs **before** deploying
> (the BullMQ CLI, `redis-cli DEL bull:<name>:*`, or a one-off script).
> After the upgrade, any jobs still sitting in `${defaultName}` will
> stay there until you clean them up manually.

Third-party consumers (e.g. a GPU pod processing only the `depth`
queue) can use BullMQ directly:

```typescript
import { Worker } from "bullmq";
import { connection } from "./redis";

new Worker("parcae-depth", processor, { connection, concurrency: 4 });
```

> ⚠️ **Booleans are strict.** `RUN_SERVER=false` actually means false. The
> earlier `z.coerce.boolean()` coercion treated _any non-empty string as
> true_, which silently broke `SERVER=false` and `DAEMON=false`. We now
> accept `{true,false,1,0,yes,no,on,off}` (case-insensitive) and reject
> the rest with a clear error at startup.

### Migrating from pre-0.8.2

Pre-0.8.2 versions enqueued every job into a single shared queue
(named `${JOB_QUEUE_NAME}`, default `parcae`). The new version routes
each job to its own queue. **Hard cutover** — no transitional worker
drains the old queue.

1. **Before deploying**, drain any in-flight jobs from the legacy
   queue. The cheapest way is to let it idle until empty:

       redis-cli LLEN bull:parcae:wait        # count waiting jobs
       redis-cli LLEN bull:parcae:active      # in-flight
       redis-cli ZCARD bull:parcae:delayed    # scheduled / retry-backoff

   Or, if you don't care about the in-flight work, nuke it:

       redis-cli --scan --pattern 'bull:parcae:*' | xargs redis-cli DEL

2. **External Workers/Queues** in your codebase that referenced the
   legacy queue name directly (e.g. `new Queue("parcae")`) need to
   move to `new Queue("parcae-<jobname>")` (dash-separated — BullMQ
   v5 rejects colons in queue names) or use `enqueue()` /
   `queue.queueNameFor("<jobname>")` instead.

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
  RouteHandler,
  Middleware,
  RouteOptions,
  RouteEntry,
  HookContext,
  HookOptions,
  HookEntry,
  JobHandler,
  JobContext,
  JobEntry,
} from "@parcae/backend";

// Response helpers
import {
  json,
  ok,
  error,
  unauthorized,
  notFound,
  badRequest,
} from "@parcae/backend";

// Services
import {
  PubSub,
  QueueService,
  addJobIfNotExists,
  QuerySubscriptionManager,
} from "@parcae/backend";
import { enqueue, lock, getQueue, getPubSub } from "@parcae/backend";
import type {
  PubSubConfig,
  QueueConfig,
  EnqueueOptions,
} from "@parcae/backend";

// Auth (interface only — implementations in separate packages)
import type {
  AuthAdapter,
  AuthSession,
  AuthSetupContext,
} from "@parcae/backend";

// Schema
import {
  SchemaResolver,
  generateSchemas,
  loadCachedSchemas,
} from "@parcae/backend";

// Config
import { parseConfig, configSchema } from "@parcae/backend";
import type { Config } from "@parcae/backend";

// Registry utilities
import {
  getRoutes,
  clearRoutes,
  getHooks,
  getHooksFor,
  clearHooks,
  getJobs,
  getJob,
  clearJobs,
} from "@parcae/backend";

// Convenience re-export
import { Model } from "@parcae/backend";
```

## License

MIT
