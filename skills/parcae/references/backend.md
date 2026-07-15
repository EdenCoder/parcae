# Backend Reference

Source: `packages/backend/src/`

## createApp()

Source: `packages/backend/src/app.ts`

Main entry point. Returns a `ParcaeApp` (`{ start, stop, schemas, models }`).

```typescript
import { createApp } from "@parcae/backend";

const app = createApp({
  models: [User, Post],         // ModelConstructor[] OR a directory path for auto-discovery
  controllers: "./controllers", // optional dir — files self-register via route.*
  hooks: "./hooks",             // optional dir — files self-register via hook.*
  jobs: "./jobs",               // optional dir — files self-register via job()
  crons: "./crons",             // optional dir — files self-register via cron()
  migrations: "./migrations",   // optional dir — files self-register via migration()
  auth: betterAuth({ ... }),    // optional AuthAdapter; omit to disable auth entirely
  version: "v1",                // API version prefix (default "v1")
  root: process.cwd(),          // resolve relative paths from here (default process.cwd())
});

await app.start({ port: 3000, dev: true });
```

### AppConfig (full option set)

| Option                   | Type                                  | Notes                                                                          |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------ |
| `models`                 | `ModelConstructor[] \| string`        | Array, or a dir scanned for exports with a non-empty `static type`.            |
| `controllers`            | `string?`                             | Dir of route files. Not auto-defaulted — pass it explicitly.                   |
| `hooks`                  | `string?`                             | Dir of hook files. Not auto-defaulted.                                         |
| `jobs`                   | `string?`                             | Dir of job files. Not auto-defaulted.                                          |
| `crons`                  | `string?`                             | Dir of cron files. Not auto-defaulted.                                         |
| `migrations`             | `string?`                             | Dir of migration files; discovered before the DB connection opens.            |
| `auth`                   | `AuthAdapter?`                        | Opt-in.                                                                         |
| `version`                | `string?`                             | Default `"v1"`.                                                                 |
| `root`                   | `string?`                             | Default `process.cwd()`.                                                        |
| `modelsPath`             | `string?`                             | Where `reflect.config.json` lives (RTTIST type gen). Auto-detected if unset.   |
| `onAuthenticatedRequest` | `(req, session, res) => void\|Promise`| Post-auth, pre-dispatch hook. See below.                                        |
| `maxSubscriptionsPerSocket` | `number?`                          | Default 500. Env `PARCAE_MAX_SUBSCRIPTIONS_PER_SOCKET` overrides.              |

Directory options are **not** auto-defaulted to conventional paths — every directory you want scanned must be passed.

`onAuthenticatedRequest` fires after the session resolves (HTTP and socket-RPC both), before route dispatch. Two uses: (1) telemetry/audit — return a Promise and the async work runs fire-and-forget without blocking; (2) step-up / kill-switch — write a response **synchronously** (e.g. `error(res, 403, ...)`); when `res.writableEnded` is true after the hook returns the framework short-circuits and the route is not dispatched. Async writes cannot short-circuit. Errors thrown by the hook are caught and logged so a faulty hook can't break the request path.

### Startup Sequence (`start()`)

0. Parse + validate env config (Zod, `parseConfig`); resolve per-process `RuntimeFlags` (`resolveRuntimeFlags`) and publish them to the service context.
1. Discover models (array or directory scan via `discoverModels` — picks up any export with a non-empty `static type`).
2. Generate `.parcae/` schemas (RTTIST/ts-morph, with caching).
3. Discover migrations (if `migrations` set) — registered via `migration()`, before the DB opens.
4. Connect Postgres through Knex (pool min 2 / max 25, optional ordinary-read replica via `DATABASE_READ_URL`).
5. Connect Redis-backed `PubSub` locks and `QueueService` (queue name from `JOB_QUEUE_NAME`, default `"parcae"`). Both have in-process fallbacks when `REDIS_URL` is unset.
6. Create `BackendAdapter`, `registerModels`, bind it once as the application adapter; detect standard Postgres vs AlloyDB. Independent contexts use `Model.bind()` rather than replacing this binding.
7. Set up auth (opt-in) — runs **before** `ensureAllTables` so auth-owned tables exist first; runs its own migrations when `ENSURE_SCHEMA=true`.
8. Run user migrations (`runMigrations`) — gated on `ENSURE_SCHEMA`, before `ensureAllTables`.
9. `ensureAllTables` — additive DDL — gated on `ENSURE_SCHEMA`.
10. Create HTTP server (Polka) + Socket.IO; wire `QuerySubscriptionManager`.
11. For server roles, verify managed-model change triggers and start the dedicated Postgres `ChangeBus` LISTEN connection. `ENSURE_SCHEMA=true` installs the triggers; otherwise missing triggers fail startup with migration guidance. Listener startup failures also fail the app.
12. Mount auth routes + session-resolve middleware; install per-request `AsyncLocalStorage` context (user + `RefLoader` for batched ref resolution); install the optional `onAuthenticatedRequest` middleware.
13. Register `/{version}/health`.
14. Register auto-CRUD routes — **only when `RUN_SERVER` is true** (`registerModelRoutes`).
15. Auto-discover + import `controllers` / `hooks` / `jobs` / `crons` (files always imported so module side effects fire identically across processes; per-flag gating applied below).
16. Attach discovered custom routes to Polka — only when `RUN_SERVER` is true.
17. Start per-job-name BullMQ workers — gated on `RUN_JOBS`.
18. Schedule in-process crons (croner) — gated on `RUN_CRONS`.
19. Socket.IO connection handling (RPC `call`, `hello`, `resync`, `route.on()` handlers, query subscribe/unsubscribe) — only when `RUN_SERVER` is true.
20. Always bind the HTTP listener to `PORT` (even worker-only processes, so health probes work).

`stop()` tears down crons, the Postgres ChangeBus, queue, pubsub, optional auth adapter, and both DB pools via `shutdownResources` (errors swallowed per-resource so a slow Redis can't block DB pool close). Startup failures use the same teardown path.

## Runtime Flags & Process Roles

A single binary runs in different roles by env. `resolveRuntimeFlags` produces `{ server, hooks, jobs, crons }`:

- **`RUN_SERVER`** (default `true`) — register CRUD routes, custom routes, Socket.IO RPC. When false the server still binds `PORT` and serves `/{version}/health` only.
- **`RUN_HOOKS`** (default `true`) — invoke model lifecycle hooks. When false, hook files are still imported (side effects fire) but the adapter skips calling them.
- **`RUN_JOBS`** (default `false`) — `true` = start a worker for every registered job; `false` = none (enqueue still works, jobs wait); `"a,b,c"` = only those job names.
- **`RUN_CRONS`** (default *follows `RUN_JOBS`*: `true` if `RUN_JOBS != false`, else `false`) — `true` / `false` / `"a,b,c"` name-list, same syntax as `RUN_JOBS`.

`SERVER` and `DAEMON` are **deprecated** (legacy bool env). `RUN_*` wins when both are set; using a legacy var logs a deprecation warning. `DAEMON=true` historically meant hooks+jobs; note `DAEMON` never controlled hooks (they default on regardless).

Boolean env vars are strictly coerced — `{true,false,1,0,yes,no,on,off}` (case-insensitive); anything else is a config error. (`z.coerce.boolean()` is deliberately avoided — it treats `"false"` as truthy, which is how legacy `SERVER`/`DAEMON` silently broke.)

## BackendAdapter

Source: `packages/backend/src/adapters/model.ts`

Server-side `ModelAdapter` implementation.

### Save

New models serialize declared columns plus overflow `data` JSONB and insert via `INSERT ... ON CONFLICT`. Existing models diff the captured save payload (after before-hooks) against `__serverSnapshot`, lock the current row, then apply scalar and nested JSONB changes atomically through the same SQL builder as `patch()`. Unchanged fields are not written, so unrelated concurrent JSON paths and scalar columns survive. Positional array edits and whole-JSON replacements carry baseline tests; an incompatible concurrent structural edit returns a `409` instead of writing the wrong path. After-save hooks receive the authoritative merged row, while internal diff application does not dispatch patch hooks. PostgreSQL triggers are the only subscription notification source.

### Overflow Column

`serialize()` splits data into:

- **Declared columns** — properties present in `__schema` get their own typed Postgres columns.
- **Overflow** — everything else is JSON-stringified into a single `data` JSONB column.

Arbitrary (undeclared) properties therefore still persist; declared properties just get dedicated columns. On read, `hydrate()` unpacks `data` back to top-level fields, but **schema-known keys win** — overflow only fills keys without a column (matters when a column is promoted from overflow to first-class). (`serialize()` is the write-side counterpart; there is no `deserialize()`.)

### Atomic JSON Patch

Generates native Postgres JSONB SQL for `json` columns:

- `jsonb_set_lax(..., 'use_json_null')` for `add` / `replace` ops
- `jsonb_insert()` for array insertions
- `#-` operator for `remove` ops
- Direct `SET` for scalar columns

Parent JSON paths are auto-materialised so a deep set into a missing object doesn't fail.

### Read/Write Split

Separate Knex instances for reads vs writes. Ordinary reads use `DATABASE_READ_URL` when configured; writes and every subscription cache read use the primary so a commit-triggered notification cannot race replica lag.

### ensureTable()

Additive DDL only (never drops by default). Skips models with `static managed = false`. Reuses a bulk introspection snapshot when called via `ensureAllTables()`.

- **Create branch (`!hasTable`)**: creates the table with the base columns `id` (PK), `data` (JSONB), `createdAt`, `updatedAt`, `tmp` (`varchar(2048)`), plus all declared schema columns, plus `createdAt`/`updatedAt` indexes.
- **Repair branch (table already exists)**: only adds **missing declared columns**, the `tmp` column if absent, and missing indexes.

> **Gotcha — base columns are write-once.** The base columns (`id`, `data`, `createdAt`, `updatedAt`, `tmp`) are emitted **only** in the create branch. The repair branch reconciles declared columns and `tmp`, but **never** re-adds `id` / `data` / `createdAt` / `updatedAt`. A pre-existing table missing `data` cannot be fixed by `ensureAllTables()` — every INSERT then crashes with `column "data" of relation X does not exist`. Never hand-write `CREATE TABLE` for a Parcae model unless you include all base columns yourself; a wrong-shape pre-existing table can only be fixed by DROP + recreate (or a `migration()` that adds the missing columns).

Obsolete-column detection (columns in the DB no longer declared on the model) logs a warning during `ensureAllTables()`; columns are dropped only when `PARCAE_DROP_OBSOLETE_COLUMNS=true`.

### Migrations (`migration()`)

Source: `packages/backend/src/routing/migration.ts`, `packages/backend/src/adapters/migrations.ts`, `packages/backend/src/adapters/migration-meta.ts`

For things `ensureTable()` can't do — renames, type changes, data backfills, new constraints against dirty data. Built on Knex's migrator with a custom `migrationSource` that reads from the in-memory registry populated by `migration()` calls. A companion `parcae_migration_meta` table stores per-migration data Knex doesn't track (checksum, description, ticket, duration).

```typescript
// migrations/20260401000000-rename-type-columns.ts
import { migration } from "@parcae/backend";

migration(
  "20260401000000-rename-type-columns",
  { description: "Legacy type columns -> typed names", ticket: "FRE-200" },
  async ({ db }) => {
    await db.raw(`ALTER TABLE activities RENAME COLUMN "type" TO "activityType"`);
  },
);

// Opt out of the default transaction (e.g. CREATE INDEX CONCURRENTLY)
migration("20260402000000-concurrent-idx", { transaction: false }, async ({ db }) => {
  await db.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ...`);
});
```

- **Quote table identifiers in raw SQL.** Table names preserve the
  camelCase of `pluralize(static type)` — `projectAssets`, not
  `project_assets`. Unquoted identifiers get lowercased by Postgres and
  fail with `relation "project_assets" does not exist`. Always write
  `ALTER TABLE "projectAssets" ...`.
- **`db.raw` eats literal `?`.** Knex treats every `?` as a binding
  placeholder, so JSONB operators (`?`, `?|`, `?&`) break with
  `syntax error at or near "$1"`. Use the function forms instead —
  `jsonb_exists(col, key)`, `jsonb_exists_any`, `jsonb_exists_all` — or
  escape as `\\?`.
- **Never delete an applied migration file.** The ledger
  (`parcae_migrations`) still records it, and Knex refuses to run ANY
  migrations while a recorded file is missing ("the migration directory
  is corrupt"). Consolidate by leaving tombstone files in place.
- State lives in `parcae_migrations` (Knex) + `parcae_migration_meta` (Parcae); written atomically inside each migration's transaction.
- **Checksum drift detection**: editing an already-applied migration throws `MigrationChecksumError`. Bypass with `--allow-checksum-drift` (CLI) or `PARCAE_ALLOW_CHECKSUM_DRIFT=true`.
- Multi-replica safe — Knex's `parcae_migrations_lock` uses `SELECT ... FOR UPDATE`.
- Sort order is lexicographic by `name` — date-prefix by convention (`parcae migrate:make` writes a `YYYYMMDDHHMMSS-slug` name).
- Each runs in a transaction by default; opt out with `{ transaction: false }`.
- Forward-only by default; rolling back without a `down` throws. Provide `{ down: ... }` for local-dev reversibility.
- Discovered before the DB opens (via `migrations: "./migrations"`); executed (with auth migrations and `ensureAllTables`) only when `ENSURE_SCHEMA=true`.
- Use raw SQL (`db.raw(...)`), not Model APIs — migrations must stay correct if a model class is later renamed or removed.

### CLI (`parcae migrate:*`)

Source: `packages/backend/src/cli/**`. Ships as a `bin` in `@parcae/backend`:

```
pnpm parcae migrate:make rename-type-columns
pnpm parcae migrate:list
pnpm parcae migrate:status
pnpm parcae migrate:latest
pnpm parcae migrate:baseline 20260401000000-rename-type-columns  # stamp-as-applied
pnpm parcae migrate:plan                                          # dry-run next pending, capture SQL
pnpm parcae migrate:rollback                                      # requires down() on every migration in the last batch
pnpm parcae migrate:unlock                                        # release a stuck lock
```

Global flags: `--json`, `--dir <path>`, `--db <url>`, `--allow-checksum-drift`. Each command reads `DATABASE_URL` from the cwd's `.env` unless `--db` is supplied. The CLI connects Knex directly — no schema resolution, no server, no queue — so it's fast and safe to run out-of-band (e.g. from CI before deploying a container).

### queryFromClient()

Secure replay of client-sent `QueryStep[]` arrays:

1. **Scope applied first** (non-negotiable, never overridable).
2. **Only whitelisted methods** replayed (`SAFE_CLIENT_METHODS`): `select`, `search`, `where`, `andWhere`, `orWhere`, `whereIn`, `whereNot`, `whereNotIn`, `whereNull`, `whereNotNull`, `whereBetween`, `orderBy`, `limit`, `offset`, `clearLimit`. (No `whereRaw`, no joins from the client.)
3. **Column names validated** against the model schema (plus `id`/`createdAt`/`updatedAt`); invalid references throw (fail loud in dev).
4. **Operators whitelisted** (`SAFE_OPERATORS`): `=`, `!=`, `<>`, `<`, `>`, `<=`, `>=`, `like`, `ilike`, `not like`, `not ilike`, `in`, `not in`, `is`, `is not`, `@>` (JSONB containment).
5. **Limit handling**: a **default limit of 25** (`DEFAULT_LIMIT`) is injected only when the client sends no `.limit()`. There is **NO upper clamp** on explicit client limits — the scope is the security boundary. `.clearLimit()` opts out of the default and caps at a **10,000** safety net. An explicit `.limit(n)` is coerced to a positive integer (falls back to 25 on parse failure).
6. Nested builder callbacks supported via `{ __nested: QueryStep[] }`.
7. `whereIn` on a `json` column is rewritten to JSONB "array contains any of" (`@>`) SQL, so `Model.whereIn("tags", [tagId])` Just Works on array columns.

### Search System

Hybrid full-text + fuzzy + optional semantic search. Extensions are created lazily the first time a model with `static searchFields` is ensured:

- `_search` generated `tsvector` column (built with `to_tsvector('english', ...)`, weighted A/B/C/D by field order) + GIN index; queried via `websearch_to_tsquery('english', ?)`.
- Per-field trigram GIN indexes (`pg_trgm` extension).
- On **AlloyDB**: also creates `vector`, `alloydb_scann` (CASCADE), and `google_ml_integration` extensions; adds an `_embedding` `vector(768)` column + ScaNN index and computes embeddings via `embedding('gemini-embedding-001', ?)`. The semantic term contributes a cosine-distance score blended with the full-text rank.

## Auto-CRUD Routes

Source: `packages/backend/src/adapters/routes.ts`

Any model with a `static scope` gets REST endpoints automatically (per scope key present). The path is `model.path` if set, else `/{version}/{pluralize(type)}`.

| Method   | Route                              | Scope key        | Description                            |
| -------- | ---------------------------------- | ---------------- | -------------------------------------- |
| `GET`    | `/v1/{pluralize(type)}`            | `read`           | List (paginated, sortable, filterable) |
| `GET`    | `/v1/{pluralize(type)}/:id`        | `read`           | Get one                                |
| `POST`   | `/v1/{pluralize(type)}`            | `create`         | Create                                 |
| `PUT`    | `/v1/{pluralize(type)}/:id`        | `update`         | Full update                            |
| `DELETE` | `/v1/{pluralize(type)}/:id`        | `delete`         | Delete                                 |
| `PATCH`  | `/v1/{pluralize(type)}/:id`        | `patch` ?? `update` | Atomic JSON Patch                   |

**Pluralization is real.** Routes, table names, and the list-response collection key are all derived via `pluralize(static type)` on both the backend (`adapters/routes.ts`, `adapters/model.ts`) and the SDK (`client.ts`). So `category → categories`, `person → people`, and a type already ending in `s` is not double-pluralized. The old naive `type + "s"` (and the backend/SDK split-brain it caused) is gone; there's a regression test at `model/src/__tests__/collection-name.test.ts`.

### Route-priority shadowing (gotcha)

Auto-CRUD routes register at **priority 200** (`AUTO_CRUD_PRIORITY`); user routes default to **100**. Lower sorts first in `getRoutes()`, so an explicit literal route like `route.get("/v1/sources/providers", ...)` always wins over the generated `GET /v1/sources/:id`. Without the gap, `providers` would be treated as a `Source` id lookup and 404 as `"source not found"` at boot (auto-CRUD registers at step 16, before controllers at step 17). Set a priority outside `[0, 199]` to opt out of the default ordering.

### Field protection on writes (gotcha)

- **System fields** `id`, `createdAt`, `updatedAt`, `type` plus the model's `static readonlyFields` are stripped from POST/PUT bodies before mass-assignment (`stripReadonly`).
- **PATCH** rejects the whole batch with **403** if any op's top-level column (first path segment) is system/readonly — fail loud rather than silently drop ops.
- **Scope-create overrides merge last** (`{ ...strippedBody, ...scopeData }`), so a request body can't override ownership fields the scope injects (e.g. `user: ctx.user.id`).
- Responses go through the model's `sanitize()` (which honours `static privateFields`).
- `:id` lookups fall back to the `tmp` column (optimistic-create reconciliation), with the scope predicate applied to both lookups so `tmp` can't bypass access control.

### Scope Functions

```typescript
static scope = {
  // Return query modifier function -- filters results
  read: (ctx) => (qb) => qb.where("user", ctx.user?.id),

  // Return object -- merged into created data (merged LAST, wins over body)
  create: (ctx) => ctx.user ? { user: ctx.user.id } : null,

  // Return null to deny access (403)
  update: (ctx) => ctx.user ? (qb) => qb.where("user", ctx.user.id) : null,

  // patch falls back to the update scope if patch is not defined
  delete: (ctx) => ctx.user ? (qb) => qb.where("user", ctx.user.id) : null,
};
```

`ScopeContext` is `{ user, params, data }`. A falsy scope result (null/undefined) → 403 Forbidden.

### List Response Shape

```jsonc
// non-socket fetch
{ "result": { "total", "totalCount", "<pluralize(type)>": [...] }, "success": true }
// socket-RPC (subscribed)
{ "result": { "total", "totalCount", "__queryHash", "<pluralize(type)>": [...] }, "success": true }
// __count=true
{ "result": { "total" }, "success": true }
```

### List Query Features

- `limit` / `offset` — pagination (see `queryFromClient` limit rules above)
- `sort` / `direction` — via `orderBy` steps
- `select` — column selection
- `__query` — serialized `QueryChain` steps from the frontend `useQuery()`
- `__count=true` — count-only response
- `__forceRefresh=true` — (socket) re-execute the cached query and emit drift ops to all subscribers on the hash

## Custom Routes

Source: `packages/backend/src/routing/route.ts`

Module-level, self-registering function API (`route.*`). Files placed under `controllers/` (or any scanned dir) are imported at startup; their `route.*` calls register into a global registry, and registered routes attach to Polka in priority order — **only when `RUN_SERVER` is true**.

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

// With middleware + priority (lower = attaches first)
route.post("/v1/upload", requireAuth, rateLimit(100), async (req, res) => {
  // req.session available after auth middleware
  ok(res, { uploaded: true });
}, { priority: 50 });

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

Each `route.*` accepts a path, zero-or-more middleware, the handler, and an optional `{ priority }` (default 100). Last function arg is the handler; everything before it is middleware; a trailing plain object is options.

### Socket.IO Event Handlers (`route.on`)

```typescript
import { route, requireSocketAuth } from "@parcae/backend";

route.on("chat:message", requireSocketAuth, async (ctx) => {
  // ctx: { socket, io, data, session, socketId, emit }
  ctx.emit("chat:chunk", { delta: "hello" });
});
```

Registered once per connection. `requireSocketAuth` is the socket equivalent of an auth gate. Middleware chains run via `runSocketChain` (call `next()` to proceed).

### Controller Class (marker only)

```typescript
import { Controller } from "@parcae/backend";

// Controller is an EMPTY auto-discovery marker base class. It has NO
// routes()/this.get/this.post methods. Register routes via module-level
// route.* (or @route.* decorators that call the same functions).
export class StatsController extends Controller {
  @route.get("/v1/stats")
  async getStats(req, res) {
    ok(res, { count: await Post.count() });
  }
}
```

`Controller` (route.ts) is an empty base class — extending it does nothing by itself. The old `routes() { this.get(...) }` pattern is fictional and throws `this.get is not a function`. Routes are registered at module load via module-level `route.*` (the `@route.*` decorator form internally calls the same functions).

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

Model lifecycle hooks with a global registry. Gated by `RUN_HOOKS` (files still import when off; the adapter just doesn't call them).

```typescript
import { hook } from "@parcae/backend";

hook.after(Post, "save", async ({ model, lock, enqueue, user }) => {
  const unlock = await lock(`index:${model.id}`);   // ttl defaults to 120000ms
  try {
    await enqueue("post:index", { postId: model.id });
  } finally {
    await unlock();
  }
});

hook.before(Post, "create", ({ model }) => {
  model.title = model.title.trim();
});

// Compensating action for an external side effect
hook.before(Patient, "create", async ({ model, onError }) => {
  const clerkUser = await clerkClient.users.createUser({ ... });
  onError(() => clerkClient.users.deleteUser(clerkUser.id)); // runs LIFO if a later step throws
  model.id = clerkUser.id;
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

### Action dispatch semantics

The adapter dispatches exactly one action per write: **`create`** for new
rows (`__isNew`), **`save`** for full re-saves of existing rows, `patch`
for JSON-patch updates, `remove` for deletes.

**The first save IS a create**: registrations for `save` automatically
alias `create`, so a save hook fires on every write of the row — new or
existing. Register `create` when you want creation-only behavior.
(Without the alias, create-only flows — likes, follows, any toggle row —
would silently bypass every save hook, validation included.)

### Hook Context

```typescript
{
  model,        // The model instance being acted upon
  action,       // The HookAction that triggered ("save" | "create" | "update" | "patch" | "remove")
  data?,        // Raw request data (when applicable)
  user?,        // Authenticated user { id, ... } | null (from request AsyncLocalStorage)
  lock(key, ttl?),             // Distributed lock; ttl default 120000ms; returns async unlock()
  enqueue(name, data, opts?),  // Queue a job; returns Job | null (deduped by jobId) | false (no REDIS_URL)
  onError(fn),                 // Register a LIFO compensating action (see below)
}
```

`onError(fn)` registers a compensating action that runs in **LIFO** order if any later before-hook, the DB write, or an after-hook throws — for rolling back external side effects (Clerk users, S3 uploads, Stripe subscriptions). Cleanup errors are logged but never replace the original error. It is a **no-op in `async: true` hooks** (those run outside the caller's error path; a warning is logged). Database writes in the synchronous operation are already rolled back transactionally; use `onError` for external effects.

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

BullMQ background jobs. Each registered job gets its own per-name queue, named `` `${JOB_QUEUE_NAME}:${jobName}` `` with all colons collapsed to dashes (BullMQ v5 rejects colons), so `post:index` → queue `parcae-post-index`. Workers start per `RUN_JOBS`.

```typescript
import { job } from "@parcae/backend";

export default job("post:index", async ({ data, bullJob, attempt }) => {
  const post = await Post.findById(data.postId);
  // ... process
  return { success: true };
});

// Per-job concurrency (e.g. external-API jobs)
job("dialogue:audio", handler, { concurrency: 24 });
```

- Registration is **idempotent on `name`** — re-registering the same name (e.g. when a file is both side-effect-imported and directly scanned) replaces the prior entry, so you don't get duplicate workers.
- Per-job concurrency comes from `{ concurrency }`; total in-flight work across opted-in jobs is the **sum** of their concurrencies.
- `RUN_JOBS=a,b,c` subscribes only to those names; unknown names in the list log a warning at startup.
- After the per-name routing cutover, nothing routes to the bare `JOB_QUEUE_NAME` queue — drain any legacy items before upgrading across that boundary.
- `JobContext` is `{ data, bullJob?, attempt? }`.

### Standalone Enqueue

```typescript
import { enqueue } from "@parcae/backend";

await enqueue("post:index", { postId: "abc" });
await enqueue("post:index", { postId: "abc" }, { jobId: "post:index:abc" }); // dedup
```

`enqueue` returns the BullMQ `Job`, `null` if deduped by `jobId`, or `false` if no queue is configured (`REDIS_URL` unset).

## Crons

Source: `packages/backend/src/routing/cron.ts`

In-process scheduled tasks backed by **croner** — **not** BullMQ jobs. Files in the `crons` directory self-register at import. Scheduling is gated by `RUN_CRONS` (default follows `RUN_JOBS`).

```typescript
import { cron } from "@parcae/backend";

export default cron("daily-digest", "0 7 * * *", async ({ data }) => {
  // data: { name, pattern, fireDate }
  await sendDigest();
});

// Allow overlapping ticks (rare), and pin a timezone:
cron("metrics", "*/10 * * * * *", handler, { overlap: true, timezone: "America/New_York" });
```

### Signature

```typescript
cron(name, pattern, handler, options?): CronEntry
```

- `name` — required, must be unique (duplicate throws).
- `pattern` — required cron expression (croner; supports seconds field).
- `handler` — `(ctx: { data: { name, pattern, fireDate } }) => any`.
- `options.overlap` (default `false`) — when false, a slow tick won't stack (croner `protect`).
- `options.timezone` — IANA zone; defaults to the process timezone (usually UTC).

**Cross-process dedup**: croner fires on every process with `RUN_CRONS` enabled. Before invoking the handler, each contender attempts a non-blocking `pubsub.tryLock("cron:tick:<name>:<fireMs>", ttl)` (Redis `SET NX EX`); exactly one wins per tick, the rest silently skip. If `tryLock` errors it fires anyway (duplicate execution possible, logged). Handler errors are caught and logged so the schedule keeps firing.

## Cross-Model Search

Source: `packages/backend/src/search.ts`

```typescript
import { searchAll } from "@parcae/backend";

route.get("/v1/search", async (req, res) => {
  const results = await searchAll(adapter, req.query.q, {
    models: [Project, User],
    scope: { user: req.session?.user },
    limit: 20,   // default 10
  });
  ok(res, { results, query: req.query.q });
});
```

Searches across models in parallel, applies each model's `scope.read`, returns a unified list sorted by relevance. **Only models with a non-empty `static searchFields` are searched.** A `null` scope result excludes that model. `limit` (default **10**) caps both each per-model query and the final merged list.

## Configuration

Environment variables validated at startup via Zod (`configSchema`):

| Variable            | Required    | Default        | Description                                                       |
| ------------------- | ----------- | -------------- | ----------------------------------------------------------------- |
| `DATABASE_URL`      | Yes         | —              | Primary Postgres connection URL                                   |
| `DATABASE_READ_URL` | No          | —              | Optional replica for ordinary reads                               |
| `REDIS_URL`         | No          | —              | Redis for queues and distributed locks (in-process fallback)      |
| `PORT`              | No          | `3000`         | HTTP port                                                         |
| `AUTH_SECRET`       | Conditional | —              | Required if auth enabled                                          |
| `NODE_ENV`          | No          | `development`  | `development` \| `production` \| `test`                           |
| `RUN_SERVER`        | No          | `true`         | Register CRUD/custom routes + Socket.IO RPC                       |
| `RUN_HOOKS`         | No          | `true`         | Invoke model lifecycle hooks                                      |
| `RUN_JOBS`          | No          | `false`        | Start BullMQ workers: `true` / `false` / `"name1,name2"`          |
| `RUN_CRONS`         | No          | follows `RUN_JOBS` | Schedule crons: `true` / `false` / `"name1,name2"`           |
| `JOB_QUEUE_NAME`    | No          | `parcae`       | Base name for per-job BullMQ queues                               |
| `SERVER`            | No          | —              | **@deprecated** — use `RUN_SERVER` (RUN_SERVER wins)              |
| `DAEMON`            | No          | —              | **@deprecated** — use `RUN_HOOKS`/`RUN_JOBS` (those win)          |
| `TRUSTED_ORIGINS`   | No          | —              | Comma-separated CORS origins                                      |
| `BACKEND_URL`       | No          | —              | For auth callbacks                                                |
| `FRONTEND_URL`      | No          | —              | Frontend URL                                                      |

Read directly from `process.env` (not part of the Zod schema):

| Variable                            | Default | Description                                                        |
| ----------------------------------- | ------- | ----------------------------------------------------------------- |
| `ENSURE_SCHEMA`                     | —       | `"true"` to run auth migrations, user migrations, `ensureAllTables` |
| `PARCAE_ALLOW_CHECKSUM_DRIFT`       | —       | `"true"` to bypass migration checksum-drift errors                |
| `PARCAE_DROP_OBSOLETE_COLUMNS`      | —       | `"true"` to drop columns no longer declared on a model           |
| `PARCAE_MAX_SUBSCRIPTIONS_PER_SOCKET` | `500` | Per-socket subscription cap                                       |
| `PARCAE_REEVAL_CONCURRENCY`         | —       | Subscription re-eval concurrency override                          |
</content>
</invoke>
