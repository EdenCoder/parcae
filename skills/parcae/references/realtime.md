# Realtime Reference

Parcae's realtime stack keeps `useQuery()` result sets live. A client subscribes to a
query; whenever any row of the watched model type is written, the server re-evaluates
the query, diffs it against the cached result, and emits surgical add/remove/update ops
back to every subscribed socket. Diffing, coalescing, and ordering are all **server-side**;
the client just applies the ops it receives.

The pieces:

- **`QuerySubscriptionManager`** (`services/subscriptions.ts`) — owns cached queries,
  re-eval, diffing, coalescing, and the wire envelope.
- **`ChangeBus`** (`services/changeBus.ts`) — cross-process model-change fan-out over PubSub.
- **`PubSub`** (`services/pubsub.ts`) — Redis-backed event bus + distributed lock, with an
  in-process fallback.
- **Socket.IO RPC bridge** (`app.ts` `io.on("connection")` + `socket-fake-res.ts`) — pipes
  socket frames through the same Polka HTTP handler as REST, plus the `hello`/`resync` protocol.
- **`useQuery()`** (`packages/sdk/src/react/useQuery.ts`) — the client cache, ops application,
  and reconnect resync.

---

## PubSub

Source: `packages/backend/src/services/pubsub.ts`

Redis-backed cross-process event bus + distributed lock. Falls back to an in-process
`eventemitter3` `EventEmitter` (and `async-lock`) when no Redis URL is configured.

### Architecture

- 3 ioredis connections: `redisLock` (Redlock), `redisRead` (subscriber), `redisWrite` (publisher).
- `emit(event, ...args)` publishes `JSON.stringify([event, ...args])` to a single `"events"`
  Redis channel; the read connection re-emits onto a local `EventEmitter`. With no Redis it
  routes straight to the local `EventEmitter`.
- `rediss://` URLs enable TLS (`rejectUnauthorized: false`).
- Constructor returns immediately; `pubsub.building` is a promise that resolves when the Redis
  connections are up.

```typescript
const off = pubsub.on("some:event", (a, b) => { /* ... */ });
pubsub.emit("some:event", a, b);
off(); // unsubscribe
```

### Distributed Locking

```typescript
const unlock = await pubsub.lock(`processing:${id}`); // timeout default 5000ms
try {
  // ... exclusive work
} finally {
  await unlock();
}
```

- Redlock is configured with `retryCount: 25`, `retryDelay: 300`, `driftFactor: 0.01`,
  `retryJitter: 200`. On Redis-level contention the outer `lock()` retries up to 10 times
  with a 50ms backoff before throwing.
- The Redis path acquires the distributed lock first, then enters an in-process `async-lock`
  queue; if the in-process wait times out it eagerly releases the Redis lock so it isn't
  leaked for its full TTL.
- No-Redis path: in-process `async-lock` only.

### Try-lock (non-blocking)

```typescript
const won = await pubsub.tryLock(`cron:tick:${ts}`, 60_000); // SET NX EX
if (won) { /* only one contender per key+window runs */ }
```

`SET NX EX` semantics with Redis (auto-released on TTL); a per-key expiry `Map` in the
in-process fallback. Useful for cron dedup.

---

## ChangeBus

Source: `packages/backend/src/services/changeBus.ts`

`QuerySubscriptionManager` is per-process — a write on instance A never reaches a subscriber
socket on instance B by itself. `ChangeBus` is the fan-out. It wraps `PubSub`, so the same
code path works in single-process dev (in-memory) and multi-process production (Redis).

### Change shape

```typescript
type ChangeOp = "insert" | "update" | "delete";
type ChangeSource = "hook" | "listen";

interface Change {
  table: string;     // DB table name == pluralize(Model.type)
  op: ChangeOp;
  id: string;        // row id
  requestId: string; // per-write tag, used to dedup the LISTEN echo
  source: ChangeSource;
}
```

No `before`/`after` row data travels on the bus — subscribers re-query through scope to get
the post-change view, which keeps payloads small.

### Dedup

Hook-path writes carry a freshly generated `requestId` (`newRequestId()` → `req_<generateId()>`).
The bus holds a TTL `Map` (default `dedupTtlMs: 5000`) of recently-seen hook requestIds and
drops any LISTEN/NOTIFY echo whose requestId matches — so a Parcae-originated write isn't
dispatched twice. The default channel is `"parcae:change"`.

### Wiring (in `app.ts`)

`BackendAdapter._notifyChange(model, op)` is the single emit point (`op` is
`insert | update | delete`):

- **Single-process / no bus** — calls `subscriptions.onModelChange(ModelClass.type)` directly.
- **Multi-process** — emits a `Change` onto the `ChangeBus` (`source: "hook"`), with the
  `requestId` taken from the active transaction frame if one is open. The bus listener in
  `app.ts` converts the table name back to a model type and calls `onModelChange`:

```typescript
changeBus.on((change) => {
  const modelType = pluralize.singular(change.table);
  subscriptions.onModelChange(modelType);
});
```

The `LISTEN/NOTIFY` poller (Postgres only) captures external writes that bypass the adapter
and emits Changes with `source: "listen"`; hook-path echoes are dropped by requestId.

---

## QuerySubscriptionManager

Source: `packages/backend/src/services/subscriptions.ts`

The heart of realtime list updates. Caches each distinct query once and shares it across all
sockets that ask for it (subscribers are a ref-counted `Set<socketId>`).

### Subscription hash

A subscription is keyed by `hashFrom(query.exec().toSQL(), expand)`:

- SHA-256 of `JSON.stringify({ sql, bindings, expand })`, truncated to **16 hex chars**.
- `sql` + `bindings` come from the query chain's `toSQL()`.
- `expand` is a sorted key derived from `.expand(...)` projections (per-ref projection field
  lists are sorted so caller argument order doesn't matter). A `.find()` and a
  `.find().expand("file")` therefore hash differently and never share a cache entry.

Clients subscribe to the Socket.IO event `query:${hash}`.

### Subscribe

`subscribe({ socketId, query, expand?, steps? }, { force? })` → `{ hash, items }`.

1. Compute the hash. Enforce the per-socket cap **before** the cache lookup (see below).
2. Cache hit → add the socket to `subscribers`; if `steps` carry `.orderBy(false)` the
   channel's `emitOrder` is turned off for everyone (one opt-out poisons the channel).
   `force: true` runs an inline `_reeval` so a drift-poll re-query converges in one round trip.
3. Cache miss → execute the query, sanitize rows, store them in a `Map<id, row>` (iteration
   order is the DB return order), index by model type, and (if any `.expand(...)`) index by
   each expanded target type.
4. Join the Socket.IO room `query:${hash}` (room-aware backend).
5. Return `{ hash, items: [...cached.result.values()] }`.

### Per-socket subscription cap

`DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET = 500` distinct hashes per socket. Hitting it logs a
warning and silently returns an empty result for the new query (a runaway-render loop or an
attack — not a legitimate case). Sized for SPA navigation given the SDK's ~60s GC keep-warm.
Overridable via `ManagerOptions.maxSubscriptionsPerSocket` /
`PARCAE_MAX_SUBSCRIPTIONS_PER_SOCKET`.

### On model change → coalesced re-eval

`onModelChange(modelType)` schedules a re-eval for:

- every cached query directly watching that type (`typeIndex`), **and**
- every cached query that expanded that type as a ref target (`expandTargetIndex`) — so a
  `File` write refreshes inlined `file` rows in unrelated parent queries (v1 invalidation is
  naive: any change to the target type wakes every subscriber that expanded it).

Re-eval is **coalesced server-side** per cached query (not debounced on the client):

- `DEFAULT_DEBOUNCE_MS = 25` — trailing debounce, reset on every incoming change.
- `DEFAULT_MAX_WAIT_MS = 100` — armed on the first change of a window, never reset, so a
  sustained write loop still flushes at most every `maxWaitMs`.
- While a re-eval is in flight, follow-up changes set a `needsFollowup` flag rather than
  queueing parallel runs; one extra cycle runs afterward.
- Both windows at `0` fire synchronously (used by tests and by callers turning coalescing off).

Per-Model override:

```typescript
class Asset extends Model {
  static realtime = { debounceMs: 250, maxWaitMs: 1000 }; // coalesce hot tables harder
}
```

Either field may be set independently; defaults fill the rest.

A `Semaphore` (default `reevalConcurrency: 8`, env `PARCAE_REEVAL_CONCURRENCY`) bounds how
many `_reeval` operations hit the DB at once, so a write-storm on a hot table can't launch N
parallel SELECTs.

### Diff + wire envelope

`_reeval` re-executes the query, sanitizes rows into a new `Map<id, row>`, and diffs against
the cached result:

```typescript
type DiffOp =
  | { op: "add"; id: string; data: Record<string, any> }
  | { op: "remove"; id: string }
  | { op: "update"; id: string; patch: Operation[] }; // RFC 6902 JSON Patch
```

- **add** — id present in the new result, absent before; carries the full row.
- **remove** — id present before, absent now.
- **update** — id in both, with a `fast-json-patch` `compare()` **RFC 6902 JSON Patch** of
  only the changed fields. `stripVolatilePatchOps` filters out **every** op whose path ends
  in `updatedAt` (not just when it's the sole op), so a pure timestamp touch reduces to an
  empty patch and doesn't emit.

The emitted envelope is:

```typescript
interface QueryEmitEnvelope {
  ops: DiffOp[];
  order?: string[]; // ordered id list, present only when membership or order changed
}
```

`order` is included whenever membership changed (any add/remove) **or** the order of
surviving ids differs from the previous order, letting ordered queries place freshly-added
rows in the right slot client-side. Queries that opted out via `.orderBy(false)`
(`emitOrder === false`) never get an `order` field. A frame with no ops and no order change
is suppressed entirely.

### Emit fan-out

With a room-aware backend, `_reeval` broadcasts once via `emitToRoom("query:${hash}", ...)`
(Socket.IO walks the room's socket set) — O(1) emits regardless of subscriber count. Without
rooms it falls back to one `emitToSocket(socketId, ...)` per subscriber. In `app.ts` these
map to `io.to(room).emit(...)` / `io.to(socketId).emit(...)`.

### Expand hydration

`_execQuery` runs `query.clone().find()`, calls each model's `sanitize()`, and — when the
subscription carried `.expand(...)` — builds an **ephemeral** `RefLoader` (re-eval fires
outside any request scope, so `getRefLoader()` is unavailable) and runs `hydrateExpansions`
to inline linked rows. The only expanded ref in production today is `File` (no private fields).

### Teardown

`unsubscribe(socketId, hash)` / `unsubscribeAll(socketId)` remove the socket, leave the room,
and — when the last subscriber leaves — tear down coalescing timers and drop the cached query
from all indexes. `disconnect` calls `unsubscribeAll`.

---

## Client query pipeline

Source: `packages/backend/src/services/query-subscription.ts`

Two helpers consolidate the "client `__query` steps → subscribed/hydrated result" pipeline so
the HTTP LIST handler and the socket `resync` handler share one code path:

- **`prepareClientQuery({ ModelClass, scopeResult, rawSteps, modelByType, adapter })`** →
  `{ query, countQuery, expandResolved, steps }`. Pure step manipulation: normalises raw
  steps (array or JSON string), peels `.expand(...)` off the SQL replay, and builds a parallel
  count chain with `limit`/`offset` stripped.
- **`runQuerySubscription({ prep, socketId, user, adapter, force? })`** →
  `{ items, hash, totalCount }`. Runs `adapter.subscriptions.subscribe(...)` and
  `countQuery.count()` in parallel, then hydrates request-side expansions on the returned items.

Consolidating these fixed a reconnect bug where `resync` served un-expanded rows
(`.expand("file")` projections snapping to `null` on every reconnect).

### LIST response shape

The auto-CRUD LIST route (`adapters/routes.ts`) returns, for a socket-bound request:

```jsonc
{
  "result": {
    "total": 12,              // items.length on this page
    "totalCount": 137,        // filter-matched count, ignoring limit/offset
    "__queryHash": "a1b2c3d4e5f60718",
    "<pluralize(type)>": [ /* items */ ]   // e.g. "projectAssets": [...]
  },
  "success": true
}
```

The collection key is `pluralize(type)` (the same `pluralize()` used for routes and table
names) — **not** `type + "s"`. The non-socket fetch fallback returns the same shape minus
`__queryHash` (no subscription). A `__count: true` request short-circuits to
`{ result: { total }, success: true }`.

---

## Socket.IO RPC Bridge

Source: `packages/backend/src/app.ts` (`server.io.on("connection")`), `socket-fake-res.ts`

Socket calls are piped through Polka's HTTP handler using fake req/res objects, so socket and
REST traffic run through the *same* middleware, auth, auto-CRUD, and custom routes — one route
definition serves both transports.

```typescript
socket.on("call", async (requestId, method, path, data) => {
  const fakeReq = {
    method: method.toUpperCase(),
    url: path,
    headers: { ...socket.handshake.headers, "content-type": "application/json" },
    body: data,
    query: mergedQuery,        // URL query merged with `data` for GET
    _socketQuery: mergedQuery, // real query stashed; Polka clobbers req.query
    session: socketSession,    // per-socket session from the `hello` handshake
    _socketRpc: true,          // marker: skip auth-middleware token resolution
    _socketId: socket.id,      // LIST handler keys the subscription on this
    _parsedUrl: { pathname, query: qs || "", _raw: path },
  };
  const fakeRes = createSocketFakeRes(socket, requestId);
  server.polka.handler(fakeReq, fakeRes);
});
```

`createSocketFakeRes(socket, requestId)` returns a minimal Node `res`:

- `writeHead` / `end` are **idempotent** and honour `writableEnded`, so a step-up gate that
  calls `error(res, 403, …)` (setting `writableEnded`, which `onAuthenticatedRequest`
  middleware checks) can't be clobbered by a downstream handler.
- `end(body)` parses the JSON body, structurally compresses it with `compress-json`,
  gzips with `pako`, and emits the bytes back as `socket.emit(requestId, compressed)`.

### Socket connection / handshake flow

1. Client connects via Socket.IO.
2. Client emits **`hello`** with `{ token }` (once per (re)connection; reconnects get a fresh
   `hello` automatically).
3. Server calls `authAdapter.resolveToken(token)` and binds the result to a per-socket
   `socketSession` (a closure variable, not `socket.session`). A missing/failed token leaves
   it `null` (anonymous).
4. Server acks `{ userId }` — the resolved user id, or `null` when anonymous.
5. The SDK's session machine transitions to `authenticated` / `anonymous`.

(There is no `authenticate` event and no `auth.ready` gate — that was old behavior.)

### Reconnect / resync

On reconnect, the SDK fires `_onResyncRequired(client)`, which batches **every** live
`useQuery` cache entry (`refs > 0`, has a chain) into **one** `resync` RPC:

```typescript
client.resync([{ key, modelType, steps, queryHash }, ...]);
```

The server's `resync` handler:

1. Installs a request-scoped context (`runWithRequestContext` with a fresh `RefLoader`) so
   expansion hydration works outside an HTTP request.
2. For each entry, re-runs `ModelClass.scope.read(...)`, then `prepareClientQuery` +
   `runQuerySubscription` against the **new** socket id — re-evaluating each query and
   re-binding its subscription on the reconnected socket.
3. Acks `{ success: true, results: [{ key, hash, items, totalCount }] }`.

The client reconciles each result back into its cache and, if the hash changed, disposes the
old `query:${oldHash}` listener and subscribes to the new one. This is what re-hydrates
`.expand(...)` projections after a reconnect.

Other socket events on the connection: `unsubscribe:query` (`{ hash }` →
`subscriptions.unsubscribe`), `disconnect` (`subscriptions.unsubscribeAll`), and any
`route.on(event)` custom Socket.IO handlers.

---

## Client-side: `useQuery()`

Source: `packages/sdk/src/react/useQuery.ts`

A module-level `Map` cache, keyed by `${modelType}:${userId ?? "anon"}:${JSON.stringify(steps)}`.
Entries are ref-counted and shared across components issuing the same query.

### Lifecycle

1. **Fetch** — `doFetch` calls `chain.find()`. The result array carries `__queryHash` and
   `__totalCount`. Items are reconciled into the entry (`SYM_SERVER_MERGE` updates existing
   model instances in place; membership changes flip the array identity).
2. **Subscribe** — once a `__queryHash` arrives (and differs from the entry's current hash),
   the entry subscribes to `query:${hash}`.
3. **Apply ops** — each incoming envelope is **applied synchronously** (no client-side
   debounce). `normalizeOpsPayload` accepts either a bare `ops` array or a `{ ops, order? }`
   envelope; `applyOps` coalesces add/update/remove and merges JSON Patch `update` ops via
   `applyPatch` + `SYM_SERVER_MERGE`. Update-only frames mutate models in place and keep the
   array identity stable (so order-insensitive consumers skip the re-render). When `order` is
   present, `reorderByIds` re-sequences the array.
4. **Render** — `entry.version++` + `notify()` drive `useSyncExternalStore` re-renders. The
   hook returns `{ items, loading, error, total, refetch, addOptimistic, removeOptimistic, onOps }`.

### Optimistic updates

`addOptimistic(item)` / `removeOptimistic(item)` maintain a per-entry `optimistic` array
merged with server items by `id` and `tmp`. When a server `add` op carries a matching `tmp`,
the optimistic instance is reconciled into the real row (`drainOptimistic`).

### Drift poll

`options.poll` (default `60_000`ms, `0` to disable) periodically refetches with
`withForceRefresh()` (→ `__forceRefresh: true`), which makes the server re-execute the cached
query against the DB and emit any drift ops to **all** subscribers on that hash. Paused while
the tab is hidden or the transport is disconnected.

### Cache management

- Ref-counted; `GC_DELAY = 60_000`ms after the last subscriber unmounts before the entry is
  disposed and deleted (cheap back-navigation; keeps subscriptions warm).
- `_purgeCacheForUser(prevUserId)` drops every entry keyed for a previous user on a session
  transition (sign-out / user switch).
- Failed fetches retry up to `MAX_RETRIES = 3` times with `[1s, 3s, 10s]` backoff.
- `prefetch(client, chain)` warms an entry outside React.
