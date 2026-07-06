---
name: parcae
description: >
  Guide to the Parcae TypeScript backend framework, where a Model class is
  simultaneously the schema, the REST/realtime API, and the type system. Use
  when reading, writing, or debugging code that imports @parcae/model,
  @parcae/backend, @parcae/sdk, or the Parcae auth/analytics packages — defining
  Models, createApp() bootstrap, scopes, hooks, jobs, migrations, the React SDK,
  or realtime queries. Do not use for unrelated TypeScript, generic ORMs
  (Prisma/Drizzle), or non-Parcae Socket.IO/Knex code.
---

# Parcae

Your class IS the schema, the API, and the type system. One `createApp()` call bootstraps persistence (Postgres, with SQLite and AlloyDB also supported via Knex), auto-CRUD REST routes, realtime Socket.IO subscriptions, background jobs, and authentication from your Model classes. No codegen, no dashboard — everything is TypeScript.

## Packages

`@parcae/model`, `@parcae/backend`, `@parcae/sdk`, `@parcae/auth-betterauth`, `@parcae/auth-clerk`, `@parcae/analytics`.

## Architecture

| Layer   | Package           | Purpose                                                                        |
| ------- | ----------------- | ----------------------------------------------------------------------------- |
| Model   | `@parcae/model`   | Universal base class; runs isomorphically on frontend and backend             |
| Backend | `@parcae/backend` | Server: Polka + Socket.IO + Knex (Postgres/SQLite/AlloyDB) + BullMQ           |
| SDK     | `@parcae/sdk`     | Client: Socket.IO transport (the only transport), React hooks, session gates  |

`@parcae/model` is standalone; backend and SDK both depend on it. Auth packages depend on backend + model.

## Model + createApp

```typescript
import { Model } from "@parcae/model";

class Post extends Model {
  static type = "post" as const; // table = pluralize(type) → "posts"
  static scope = {
    read: (ctx) => (qb) => qb.where("user", ctx.user?.id),
    create: (ctx) => (ctx.user ? { user: ctx.user.id } : null),
  };

  user!: User; // Reference → VARCHAR FK
  title: string = ""; // → VARCHAR
  published: boolean = false;
}

import { createApp } from "@parcae/backend";

const app = createApp({ models: [User, Post], controllers: "./controllers" });
await app.start({ port: 3000 });
```

Table name, the auto-CRUD path, and the list-response collection key all derive from `pluralize(static type)` on both backend and SDK.

## Key Patterns

- **Class IS the schema** — ts-morph resolves TypeScript property types into Postgres columns at startup; no decorators or schema files.
- **Adapter pattern** — `Model.use(adapter)` swaps `BackendAdapter` (Knex/Postgres) for `FrontendAdapter` (transport); identical query code runs everywhere.
- **Explicit writes** — instance is the data store (no Proxy); persist via `save()`, `patch(ops)`, or `flush()`.
- **Scopes are row-level security** — composable functions returning a query modifier, a defaults object, or `null` (deny).
- **Self-registration** — files in `controllers/`, `hooks/`, `jobs/`, `crons/`, `migrations/` register via `route.*`, `hook.before/after`, `job()`, `cron()`, `migration()` at import time.
- **Socket RPC bridge** — Socket.IO calls reuse the HTTP middleware/auth/routing path.

## Gotchas

- The **backend** injects a default `.limit(25)` when a client query sends none — list views silently truncate to 25 rows. Set an explicit `.limit(N)`, or `.clearLimit()` to opt out.
- Never call `Model.where()` with no arguments.
- Migrations are additive-only: `ensureAllTables()` creates missing tables/columns/indexes but never drops; use `migration()` for renames, type changes, and backfills.
- **Raw SQL: quote table identifiers.** Tables preserve the camelCase of `pluralize(type)` (`"projectAssets"`, not `project_assets`); unquoted names get lowercased by Postgres → `relation does not exist`. And `db.raw` consumes a literal `?` as a binding placeholder — use `jsonb_exists(col, key)` (and friends) instead of JSONB `?` operators.
- **Hooks: the first save IS a create.** The adapter dispatches `create` for new rows and `save` for re-saves; `save` registrations alias `create` automatically. Register `create` for creation-only behavior; never rely on a `save` hook NOT firing on create.
- **Defining a Model isn't registering it.** The class must be listed in `createApp({ models: [...] })` — an exported-but-unlisted model gets no table, no routes, no realtime.
- **Never delete an applied migration file** — the `parcae_migrations` ledger still records it and Knex refuses to run any migrations while a recorded file is missing.
- Server-maintained counters: declare the column in `static readonlyFields` (clients can't write it) and recount from an after-hook — recounts self-heal where increments drift.
- Undeclared properties spill into a `data` JSONB overflow column; only declared properties get typed, indexable columns.
- A scope function returning `null` denies the request (responds forbidden).

## Reference Files

- **references/model.md** — Model class, schema resolution, column types, query chain, save/patch/flush, references.
- **references/backend.md** — createApp() startup, BackendAdapter, auto-CRUD + custom routes, hooks, jobs, migrations, config/env.
- **references/sdk.md** — createClient(), SocketTransport, React hooks (useQuery, useApi, useSetting, session gates), ParcaeProvider.
- **references/auth.md** — AuthAdapter interface, Better Auth, Clerk, session resolution.
- **references/realtime.md** — PubSub (Redis), QuerySubscriptionManager, subscription lifecycle, diff ops.
- **references/analytics.md** — @parcae/analytics: Period, ActivityEvent, Metric, Detector/Finding/StoryComposer, Contract, materialized views.
