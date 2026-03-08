---
name: parcae
description: >
  Parcae TypeScript backend framework guide. Use when working on or asking about
  code using @parcae/model, @parcae/backend, or @parcae/sdk. Covers: Model class
  (class-is-schema, adapter pattern, static query API, Proxy-based change tracking),
  createApp() bootstrap, auto-CRUD routes from scopes, custom routes via route.*,
  model lifecycle hooks via hook.before/hook.after, BullMQ background jobs,
  BackendAdapter (Knex/Postgres, atomic JSON Patch, overflow JSONB column),
  FrontendAdapter (Valtio + transport), createClient() SDK, SocketTransport,
  SSETransport, React hooks (useQuery, useApi, useSetting, auth gates),
  ParcaeProvider, PubSub (Redis), QuerySubscriptionManager (realtime list diffs),
  ts-morph schema resolution, Better Auth integration, Clerk integration,
  search (full-text + trigram + vector), or any Parcae application code.
---

# Parcae

Your class IS the schema, the API, and the type system. One `createApp()` call bootstraps Postgres persistence, auto-CRUD REST routes, realtime WebSocket subscriptions, background jobs, and authentication from your Model classes.

No codegen, no dashboard, no vendor lock-in. Everything is TypeScript.

## Packages

`@parcae/model`, `@parcae/backend`, `@parcae/sdk`, `@parcae/auth-betterauth`, `@parcae/auth-clerk`.

## Architecture

Three-layer design with an adapter pattern at the center:

| Layer   | Package           | Purpose                                                           |
| ------- | ----------------- | ----------------------------------------------------------------- |
| Model   | `@parcae/model`   | Universal base class, runs isomorphically on frontend and backend |
| Backend | `@parcae/backend` | Server framework: Polka + Socket.IO + Knex/Postgres + BullMQ      |
| SDK     | `@parcae/sdk`     | Client: transports (Socket.IO / SSE), React hooks, auth gates     |

**Key dependency flow:** `@parcae/model` is standalone. Backend and SDK both depend on it. Auth packages peer-depend on backend + model.

## Quick Reference

### Defining a Model

```typescript
import { Model } from "@parcae/model";

class Post extends Model {
  static type = "post" as const;
  static scope = {
    read: (ctx) => (qb) =>
      qb.where("published", true).orWhere("user", ctx.user?.id),
    create: (ctx) => (ctx.user ? { user: ctx.user.id } : null),
    update: (ctx) => (ctx.user ? (qb) => qb.where("user", ctx.user.id) : null),
    delete: (ctx) => (ctx.user ? (qb) => qb.where("user", ctx.user.id) : null),
  };

  user!: User; // Reference -> VARCHAR foreign key
  title: string = ""; // string -> VARCHAR(2048)
  body: PostBody = {}; // object -> JSONB
  published: boolean = false;
  views: number = 0; // number -> INTEGER
}
```

No decorators. TypeScript property types are resolved by ts-morph at startup and mapped to Postgres columns. Undeclared properties spill into a `data` JSONB overflow column.

### Backend App

```typescript
import { createApp } from "@parcae/backend";
import { betterAuth } from "@parcae/auth-betterauth";

const app = createApp({
  models: [User, Post], // or "./models" for auto-discovery
  controllers: "./controllers",
  hooks: "./hooks",
  jobs: "./jobs",
  auth: betterAuth({ providers: ["email"] }),
});

await app.start({ port: 3000 });
```

### Custom Routes, Hooks, Jobs

```typescript
// controllers/stats.ts
import { route, ok } from "@parcae/backend";

route.get("/v1/stats", async (req, res) => {
  ok(res, { count: await Post.count() });
});

// hooks/post-log.ts
import { hook } from "@parcae/backend";

hook.after(Post, "save", async ({ model, enqueue }) => {
  await enqueue("post:index", { postId: model.id });
});

// jobs/post-index.ts
import { job } from "@parcae/backend";

job("post:index", async ({ data }) => {
  const post = await Post.findById(data.postId);
  // ... index logic
});
```

Files in `controllers/`, `hooks/`, `jobs/` self-register at import time via global registries. No manual wiring.

### Client SDK

```tsx
import { createClient } from "@parcae/sdk";
import { ParcaeProvider, useQuery, Authenticated } from "@parcae/sdk/react";
import { betterAuth } from "@parcae/auth-betterauth/client";

// Standalone
const client = createClient({ url: "http://localhost:3000" });

// React
<ParcaeProvider url="http://localhost:3000" auth={betterAuth()}>
  <Authenticated>
    <PostList />
  </Authenticated>
</ParcaeProvider>;

function PostList() {
  const { items, loading } = useQuery(
    Post.where({ published: true }).orderBy("createdAt", "desc"),
  );
  // items update in realtime via QuerySubscriptionManager
}
```

## Key Patterns

1. **Class IS the schema** -- No decorators, no separate schema files. ts-morph reads TypeScript types and maps them to Postgres columns.

2. **Adapter pattern** -- `Model.use(adapter)` switches between BackendAdapter (Knex/Postgres) and FrontendAdapter (Valtio/Transport). Same query code runs everywhere.

3. **Scopes as security** -- Row-level security via composable functions. Return `null` to deny, a query modifier function to filter, or an object to inject defaults.

4. **Global self-registration** -- Routes, hooks, and jobs register into module-level arrays at import time. `createApp()` auto-discovers files in configured directories.

5. **Overflow column** -- Undeclared properties spill into a `data` JSONB column. Declared properties get typed Postgres columns for indexing/querying.

6. **Socket RPC bridge** -- Socket.IO calls are piped through Polka's HTTP handler as fake requests, so sockets share identical middleware, auth, and routing with HTTP.

7. **Additive-only migration** -- `ensureAllTables()` creates tables, columns, and indexes if missing. Never drops anything.

8. **Lazy query chains** -- Queries can be built before the adapter is set. Terminal methods (`.find()`, `.first()`, `.count()`) wait for the adapter asynchronously.

## Reference Files

For detailed API reference, read these as needed:

- **[references/model.md](references/model.md)** -- Model class internals, schema resolution, column types, query chain API, Proxy mechanics, change tracking, reference proxies
- **[references/backend.md](references/backend.md)** -- createApp() startup sequence, BackendAdapter (save/patch/query), auto-CRUD routes, custom routes, hooks, jobs, response helpers, config/env vars
- **[references/sdk.md](references/sdk.md)** -- createClient(), SocketTransport, SSETransport, AuthGate, React hooks (useQuery, useApi, useSetting), ParcaeProvider, auth gate components
- **[references/auth.md](references/auth.md)** -- AuthAdapter interface, Better Auth server/client setup, Clerk adapter, session resolution
- **[references/realtime.md](references/realtime.md)** -- PubSub (Redis), QuerySubscriptionManager, subscription lifecycle, diff ops, Socket.IO connection handling

## Directory Structure

```
packages/
  model/src/
    Model.ts                 # Core Model class (~750 lines)
    adapters/types.ts        # ModelAdapter interface, QueryChain, column types
    adapters/client.ts       # FrontendAdapter (Valtio + Transport)
  backend/src/
    app.ts                   # createApp() entry point
    server.ts                # Polka + Socket.IO server
    config.ts                # Zod-validated env config
    adapters/model.ts        # BackendAdapter (Knex/Postgres, ~1250 lines)
    adapters/routes.ts       # Auto-CRUD route generator
    routing/route.ts         # route.get/post/put/patch/delete + Controller class
    routing/hook.ts          # hook.before/hook.after
    routing/job.ts           # job() registration
    services/pubsub.ts       # Redis pub/sub + distributed lock
    services/queue.ts        # BullMQ queue service
    services/subscriptions.ts # QuerySubscriptionManager
    schema/resolver.ts       # ts-morph schema resolution
    schema/generate.ts       # Schema generation + caching (.parcae/)
  sdk/src/
    client.ts                # createClient() factory
    auth-gate.ts             # Valtio-reactive auth state machine
    transports/socket.ts     # SocketTransport (Socket.IO)
    transports/sse.ts        # SSETransport (HTTP + EventSource)
    react/Provider.tsx        # ParcaeProvider
    react/useQuery.ts         # Realtime query hook
    react/useApi.ts           # HTTP method hooks
    react/useSetting.ts       # Persistent setting hook
    react/gates.tsx           # Authenticated/Unauthenticated/AuthLoading
  auth-betterauth/src/
    index.ts                 # betterAuth() server adapter
    client.ts                # betterAuth() client adapter
  auth-clerk/src/
    index.ts                 # clerk() server adapter
```
