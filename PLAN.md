# Parcae

> The three Fates of Roman mythology — Nona spins the thread, Decima measures it, Morta cuts it.
> Parcae spins up your backend from pure TypeScript classes.

A TypeScript backend framework + client SDK where your class properties ARE the schema. No decorators required, no schema duplication, full type safety from database to React component.

## What It Does

```typescript
// models/Post.ts — this IS the schema
import { Model } from "@parcae/model";

class Post extends Model {
  static type = "post" as const;

  user: User; // reference → VARCHAR, lazy-loading proxy
  title: string = ""; // string → VARCHAR
  body: PostBody; // object → JSONB
  tags: string[] = []; // array → JSONB
  published: boolean = false; // boolean → BOOLEAN
  views: number = 0; // number → INTEGER
}
```

```typescript
// index.ts — that's the entire backend
import { createApp } from "@parcae/backend";

const app = createApp({ models: "./models" });
await app.start();
// → Postgres tables created, CRUD routes live, WebSocket ready, React hooks work
```

```tsx
// client — fully typed, realtime
import { ParcaeProvider, useQuery } from "@parcae/sdk/react";

function PostList() {
  const { items } = useQuery(Post.where({ published: true }));
  return items.map((post) => (
    <div>
      <h2>{post.title}</h2> {/* string — typed */}
      <span>{post.user.name}</span> {/* ref loads via Suspense */}
    </div>
  ));
}
```

## Core Ideas

1. **Class properties ARE the schema** — no `static columns`, no interfaces, no Zod schemas. TypeScript types map directly to Postgres columns via RTTIST runtime reflection.

2. **Direct property access** — `post.title` not `post.get("title")`. Fully typed. A Proxy handles change tracking, reference resolution, and reactivity behind the scenes.

3. **`$` convention for raw IDs** — `post.user` returns a lazy-loading User proxy. `post.$user` returns the raw string ID. No loading, no magic.

4. **Express-compatible routing** — `route.post("/path", middleware, handler)`. Polka under the hood. Middleware works the same as Express.

5. **Controllers are optional sugar** — class-based `Controller` with `@route.post()` decorators if you prefer OOP. Internally calls the same `route.*` functions.

6. **Auto-CRUD from models** — any model with `static type` gets full REST endpoints automatically. Scope-based row-level security.

7. **Realtime by default** — `useQuery()` subscribes to live updates. Server diffs queries on model changes and pushes surgical ops.

8. **`.parcae/` auto-generation** — RTTIST typegen runs at startup (like Next.js `.next/`). The developer never configures or runs it manually.

9. **Scopes are query-based** — intentionally raw query builder functions for maximum flexibility (OR clauses, joins, subqueries).

10. **Adapter pattern** — same Model code runs on frontend (Valtio + Socket.IO) and backend (Knex + Postgres). Write once, use everywhere.

## Packages

| Package           | npm      | Description                                                                                              |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `@parcae/model`   | model/   | Model base class, Proxy system, FrontendAdapter, query builder, adapter types                            |
| `@parcae/backend` | backend/ | createApp(), BackendAdapter, auto-CRUD, .parcae/ generation, route/hook/job, PubSub, Queue, auth, config |
| `@parcae/sdk`     | sdk/     | createClient() Socket.IO transport, React provider + hooks                                               |

## Architecture

```
Consumer App
├── models/Post.ts          ← pure TypeScript class (schema)
├── controllers/media.ts    ← route.post() or Controller class
├── hooks/post-search.ts    ← hook(Post, "after", ["save"])
├── jobs/post-index.ts      ← job("post:index", handler)
├── index.ts                ← createApp({ models: "./models" })
└── .parcae/                ← auto-generated (gitignored)
    ├── metadata.typelib.ts     ← RTTIST type metadata
    ├── schema.ts               ← resolved column schemas
    └── registry.ts             ← auto-discovered components

@parcae/backend (server)
├── createApp()             ← bootstrap orchestrator
├── BackendAdapter          ← Knex/Postgres persistence
├── Auto-CRUD generator     ← REST routes from model metadata
├── QuerySubscriptionManager← realtime query subscriptions
├── route/hook/job          ← function APIs + Controller class
├── PubSub (Redis)          ← cross-process events + distributed locks
├── Queue (BullMQ)          ← background job processing
├── Auth (Better Auth)      ← email/password + OAuth
└── Config (Zod)            ← env-validated configuration

@parcae/model (shared)
├── Model base class        ← Proxy-based typed property access
├── ModelAdapter interface   ← save/remove/findById/query/patch
├── FrontendAdapter         ← Valtio + Socket.IO transport
├── QueryChain<T>           ← typed, serializable query builder
└── Reference proxy         ← lazy-loading for Model refs

@parcae/sdk (client)
├── createClient()          ← Socket.IO connection + compression
├── ParcaeProvider          ← React context provider
├── useQuery()              ← realtime query subscriptions
├── useSetting()            ← key-value user settings
├── useApi()                ← pre-bound HTTP methods
└── useConnectionStatus()   ← connection state
```

## Type Reflection: RTTIST

RTTIST (Runtime Type Information System for TypeScript) provides runtime access to TypeScript types. At startup, `createApp()` runs RTTIST's typegen which generates metadata from your TypeScript source. This metadata tells the framework:

- `user: User` → property type is a class extending Model → **reference** (VARCHAR storing ID)
- `title: string` → string primitive → **VARCHAR**
- `body: PostBody` → object literal → **JSONB**
- `published: boolean` → boolean primitive → **BOOLEAN**
- `views: number` → number primitive → **INTEGER**

The `.parcae/` directory (like `.next/`) stores this generated metadata. It's gitignored and regenerated on startup. In dev mode, it watches for file changes and regenerates incrementally.

**Fallback plan:** If RTTIST stalls (it's currently rc.4), the consumer-facing API stays identical — we swap to a custom TypeScript transformer (`@parcae/compiler`, ~150 lines) that injects `static __schema` on Model subclasses. The model definition syntax doesn't change.

## Milestones

### M0: Repository & Build Scaffolding

- [DOL-143] Scaffold monorepo (pnpm workspaces + turborepo)
- [DOL-144] RTTIST integration — .parcae/ auto-generation

### M1: @parcae/model — Core Model System

- [DOL-145] Model base class — typed property access via Proxy
- [DOL-146] ModelAdapter interface & FrontendAdapter
- [DOL-147] Typed query builder
- [DOL-148] Lazy-loading reference proxy (post.user → User)

### M2: @parcae/backend — Server Framework

- [DOL-149] createApp() bootstrap & config system
- [DOL-150] BackendAdapter (Knex/Postgres persistence)
- [DOL-151] Auto-CRUD route generator
- [DOL-152] route(), hook(), job() function APIs
- [DOL-153] QuerySubscriptionManager — realtime query subscriptions
- [DOL-154] PubSub service (Redis) + Queue service (BullMQ)
- [DOL-155] Better Auth integration

### M3: @parcae/sdk — Client SDK & React

- [DOL-156] createClient() — Socket.IO transport
- [DOL-157] React provider + hooks (useQuery, useSetting, useApi)

### M4: Integration Testing & Docs

- [DOL-158] Example app — minimal working Parcae application
- [DOL-159] Dollhouse migration guide

## Extraction Source Map

What comes from Dollhouse → where it goes in Parcae:

| Dollhouse Source                              | Lines | Generic % | Parcae Target                              |
| --------------------------------------------- | ----- | --------- | ------------------------------------------ |
| `apps/api/index.ts` (Backend bootstrap)       | 1078  | 85%       | `@parcae/backend` createApp()              |
| `apps/api/base/controller.ts` (decorators)    | 232   | 100%      | `@parcae/backend` Controller class         |
| `apps/api/base/daemon.ts`                     | 76    | 100%      | `@parcae/backend` (future)                 |
| `apps/api/adapters/model.ts` (BackendAdapter) | 829   | 98%       | `@parcae/backend` BackendAdapter           |
| `apps/api/adapters/routes.ts` (auto-CRUD)     | 373   | 100%      | `@parcae/backend` auto-CRUD                |
| `apps/api/adapters/subscriptions.ts`          | 308   | 100%      | `@parcae/backend` QuerySubscriptionManager |
| `apps/api/utilities/pubsub.ts`                | 186   | 100%      | `@parcae/backend` PubSub                   |
| `apps/api/utilities/queue.ts`                 | 172   | 100%      | `@parcae/backend` Queue                    |
| `apps/api/auth.ts`                            | 77    | 80%       | `@parcae/backend` auth                     |
| `sdk/core/Model.ts`                           | 743   | 98%       | `@parcae/model` Model                      |
| `sdk/core/adapters/types.ts`                  | 237   | 100%      | `@parcae/model` types                      |
| `sdk/core/adapters/client.ts`                 | 265   | 95%       | `@parcae/model` FrontendAdapter            |
| `sdk/core/Dollhouse.ts`                       | 667   | 95%       | `@parcae/sdk` createClient()               |
| `sdk/providers/dollhouse.tsx`                 | 79    | 95%       | `@parcae/sdk` ParcaeProvider               |
| `sdk/hooks/query.ts`                          | 421   | 95%       | `@parcae/sdk` useQuery                     |
| `sdk/hooks/setting.ts`                        | 73    | 100%      | `@parcae/sdk` useSetting                   |
| `sdk/hooks/api.ts`                            | 45    | 100%      | `@parcae/sdk` useApi                       |

**Total extractable:** ~5,861 lines → ~4,500 lines after cleanup/dedup

## Dependency Tree

```
@parcae/model
├── rttist              # runtime type reflection
├── valtio              # reactive proxies (frontend)
├── fast-json-patch     # RFC 6902 JSON Patch
├── eventemitter3       # lifecycle events
└── short-unique-id     # ID generation

@parcae/backend
├── @parcae/model
├── @rttist/typegen     # type metadata generation (build-time)
├── polka               # HTTP server (Express-compatible)
├── trouter             # trie-based URL routing
├── socket.io           # WebSocket server
├── knex                # SQL query builder
├── pg                  # PostgreSQL driver
├── bullmq              # job queue
├── ioredis             # Redis client
├── @sesamecare-oss/redlock  # distributed locking
├── better-auth         # authentication
├── pako                # gzip compression
├── compress-json       # response compression
├── pluralize           # model type → table name
├── zod                 # config validation
└── winston             # logging

@parcae/sdk
├── @parcae/model
├── socket.io-client    # WebSocket client
├── pako                # gzip compression
├── compress-json       # response decompression
└── react (peer)        # React 18+
```

## Consumer Setup

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
# .env
DATABASE_URL=postgresql://localhost:5432/myapp
```

```bash
node index.ts
# → .parcae/ generated
# → Tables created
# → CRUD routes live at /v1/posts
# → WebSocket ready
```
