# Backend Reference

Source: `packages/backend/src/`

## createApp()

Source: `packages/backend/src/app.ts` (~558 lines)

Main entry point. 17-step startup sequence:

```typescript
import { createApp } from "@parcae/backend";

const app = createApp({
  models: [User, Post],        // array or directory path for auto-discovery
  controllers: "./controllers", // optional, auto-discovered
  hooks: "./hooks",             // optional, auto-discovered
  jobs: "./jobs",               // optional, auto-discovered
  auth: betterAuth({ ... }),    // optional AuthAdapter
  version: "v1",                // API version prefix
  root: process.cwd(),          // resolve relative paths from here
});

await app.start({ port: 3000, dev: true });
```

### Startup Sequence

1. Parse + validate env config (Zod)
2. Discover models (array or directory scan)
3. Generate `.parcae/` type metadata (ts-morph, with SHA-256 caching)
4. Connect Postgres (Knex, optional read replica)
5. Connect Redis (PubSub + Queue, optional)
6. Create `BackendAdapter`, call `Model.use()`
7. Detect database engine (AlloyDB vs standard Postgres)
8. Set up auth adapter (runs BEFORE schema migration)
9. Ensure tables exist (additive DDL -- never drops)
10. Create HTTP server (Polka) + WebSocket (Socket.IO)
11. Set up `QuerySubscriptionManager`
12. Mount auth middleware + routes
13. Register auto-CRUD routes
14. Auto-discover and import controllers/hooks/jobs
15. Apply discovered routes to Polka
16. Start BullMQ workers
17. Set up Socket.IO connection handling (RPC, auth, subscriptions)
18. Start HTTP listener

## BackendAdapter

Source: `packages/backend/src/adapters/model.ts` (~1248 lines)

Server-side `ModelAdapter` implementation.

### Save (Upsert)

```
INSERT ... ON CONFLICT MERGE
```

Serializes model data, splits into declared columns vs. overflow `data` JSONB, upserts via Knex. Fires before/after hooks, then notifies QuerySubscriptionManager.

### Atomic JSON Patch

Generates native Postgres JSONB SQL for JSON columns:

- `jsonb_set_lax()` for `add`/`replace` ops
- `jsonb_insert()` for array insertions
- `#-` operator for `remove` ops
- Direct `SET` for scalar columns

### Read/Write Split

Separate Knex instances for reads vs writes. Queries default to read replica; writes always use primary.

### ensureTable()

Additive DDL migration:

- Creates tables if missing (with `id`, `data`, `createdAt`, `updatedAt` base columns)
- Adds columns if missing (never drops)
- Creates indexes if missing
- Skips models with `managed = false`

### queryFromClient()

Secure replay of client-sent `QueryStep[]` arrays:

1. Scope applied first (non-negotiable)
2. Only whitelisted methods replayed (no `whereRaw`, no joins from client)
3. Column names validated against model schema
4. Operators whitelisted (`=`, `!=`, `<`, `>`, `<=`, `>=`, `like`, `ilike`, etc.)
5. Limit clamped to max 100, default 25
6. Nested builder callbacks supported via `{ __nested: QueryStep[] }`

### Search System

Hybrid full-text + fuzzy + optional semantic search:

- `_search` generated tsvector column + GIN index (weighted by field order: A, B, C, D)
- Per-field trigram GIN indexes (`pg_trgm`)
- On AlloyDB: `_embedding` vector(768) column + ScaNN index + Gemini embeddings via `google_ml_integration`

### Overflow Column

`serialize()` splits data into:

- **Declared columns**: Properties in `__schema` get their own typed Postgres columns
- **Overflow**: Everything else goes into a `data` JSONB column

This means arbitrary properties persist -- declared properties just get dedicated columns.

## Auto-CRUD Routes

Source: `packages/backend/src/adapters/routes.ts` (~284 lines)

Any model with a `scope` gets full REST endpoints automatically:

| Method   | Route             | Scope    | Description                            |
| -------- | ----------------- | -------- | -------------------------------------- |
| `GET`    | `/v1/{type}s`     | `read`   | List (paginated, sortable, filterable) |
| `GET`    | `/v1/{type}s/:id` | `read`   | Get one                                |
| `POST`   | `/v1/{type}s`     | `create` | Create                                 |
| `PUT`    | `/v1/{type}s/:id` | `update` | Full update                            |
| `DELETE` | `/v1/{type}s/:id` | `delete` | Delete                                 |
| `PATCH`  | `/v1/{type}s/:id` | `patch`  | Atomic JSON Patch                      |

### Scope Functions

```typescript
static scope = {
  // Return query modifier function -- filters results
  read: (ctx) => (qb) => qb.where("user", ctx.user?.id),

  // Return object -- merged into created data
  create: (ctx) => ctx.user ? { user: ctx.user.id } : null,

  // Return null to deny access
  update: (ctx) => ctx.user ? (qb) => qb.where("user", ctx.user.id) : null,

  // patch falls back to update scope if not defined
  delete: (ctx) => ctx.user ? (qb) => qb.where("user", ctx.user.id) : null,
};
```

### List Query Features

- `limit` / `offset` / `page` -- pagination
- `sort` / `direction` -- ordering
- `select` -- column selection
- `__query` -- serialized QueryChain steps from frontend `useQuery()`

## Custom Routes

Source: `packages/backend/src/routing/route.ts`

Express-compatible function API with global self-registration:

```typescript
import {
  route,
  ok,
  error,
  unauthorized,
  notFound,
  badRequest,
} from "@parcae/backend";

// Simple route
route.get("/v1/stats", async (req, res) => {
  ok(res, { count: await Post.count() });
});

// With middleware
route.post("/v1/upload", requireAuth, rateLimit(100), async (req, res) => {
  // req.session available after auth middleware
  ok(res, { uploaded: true });
});

// All HTTP methods
route.get(path, ...handlers);
route.post(path, ...handlers);
route.put(path, ...handlers);
route.patch(path, ...handlers);
route.delete(path, ...handlers);
route.options(path, ...handlers);
route.head(path, ...handlers);
route.all(path, ...handlers);
```

Routes support variadic middleware and priority ordering (lower = registered first).

### Controller Class (Optional)

```typescript
import { Controller } from "@parcae/backend";

class StatsController extends Controller {
  routes() {
    this.get("/v1/stats", this.getStats);
  }

  async getStats(req, res) {
    ok(res, { count: await Post.count() });
  }
}

export default new StatsController();
```

### Response Helpers

```typescript
json(res, status, body)        // Raw JSON response
ok(res, result)                // 200, { result, success: true }
error(res, status, message)    // { result: null, success: false, error }
unauthorized(res)              // 401
notFound(res, what?)           // 404
badRequest(res, message)       // 400
```

## Hooks

Source: `packages/backend/src/routing/hook.ts`

Model lifecycle hooks with global registry:

```typescript
import { hook } from "@parcae/backend";

hook.after(Post, "save", async ({ model, lock, enqueue, user }) => {
  const unlock = await lock(`index:${model.id}`);
  try {
    await enqueue("post:index", { postId: model.id });
  } finally {
    await unlock();
  }
});

hook.before(Post, "create", ({ model }) => {
  model.title = model.title.trim();
});
```

### Hook Signature

```typescript
hook.before(ModelClass, action, handler, options?)
hook.after(ModelClass, action, handler, options?)
```

| Param              | Values                                                  |
| ------------------ | ------------------------------------------------------- |
| `action`           | `"save"`, `"create"`, `"update"`, `"patch"`, `"remove"` |
| `options.async`    | `true` = fire-and-forget (non-blocking)                 |
| `options.priority` | Lower runs first (default 100)                          |

### Hook Context

```typescript
{
  model,        // The model instance
  action,       // Which action triggered
  data?,        // Request data (for create/update)
  user?,        // Authenticated user (if available)
  lock(key),    // Distributed lock (returns unlock function)
  enqueue(name, data, opts?),  // Queue a background job
}
```

### Hook Execution Order

| Operation                 | Before          | After          |
| ------------------------- | --------------- | -------------- |
| `model.save()` (new)      | `before:create` | `after:create` |
| `model.save()` (existing) | `before:save`   | `after:save`   |
| `model.patch()`           | `before:patch`  | `after:patch`  |
| `model.remove()`          | `before:remove` | `after:remove` |

Synchronous hooks are awaited in priority order. Async hooks (`async: true`) fire-and-forget.

## Jobs

Source: `packages/backend/src/routing/job.ts`

BullMQ background jobs:

```typescript
import { job } from "@parcae/backend";

job("post:index", async ({ data, bullJob, attempt }) => {
  const post = await Post.findById(data.postId);
  // ... process
  return { success: true };
});
```

- 3 retries with exponential backoff (5s base)
- Dedup via jobId: `await enqueue("post:index", data, { jobId: "unique-key" })`

### Standalone Enqueue

```typescript
import { enqueue } from "@parcae/backend";

await enqueue("post:index", { postId: "abc" });
await enqueue("post:index", { postId: "abc" }, { jobId: "post:index:abc" }); // dedup
```

## Cross-Model Search

Source: `packages/backend/src/search.ts`

```typescript
import { searchAll } from "@parcae/backend";

route.get("/v1/search", async (req, res) => {
  const results = await searchAll(adapter, req.query.q, {
    models: [Project, User],
    scope: { user: req.session?.user },
    limit: 20,
  });
  ok(res, { results, query: req.query.q });
});
```

Searches across multiple models in parallel, applies read scopes, returns unified results sorted by relevance.

## Configuration

Environment variables validated at startup via Zod:

| Variable            | Required    | Default       | Description                  |
| ------------------- | ----------- | ------------- | ---------------------------- |
| `DATABASE_URL`      | Yes         | --            | PostgreSQL connection        |
| `DATABASE_READ_URL` | No          | --            | Read replica                 |
| `REDIS_URL`         | No          | --            | Redis for PubSub + Queue     |
| `PORT`              | No          | `3000`        | HTTP port                    |
| `AUTH_SECRET`       | Conditional | --            | Required if auth enabled     |
| `NODE_ENV`          | No          | `development` | Environment                  |
| `SERVER`            | No          | `true`        | Run HTTP + WebSocket         |
| `DAEMON`            | No          | `false`       | Run background workers       |
| `TRUSTED_ORIGINS`   | No          | --            | Comma-separated CORS origins |
| `BACKEND_URL`       | No          | --            | For auth callbacks           |
| `FRONTEND_URL`      | No          | --            | Frontend URL                 |
| `ENSURE_SCHEMA`     | No          | --            | Run DDL migration            |
