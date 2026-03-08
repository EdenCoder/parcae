# Realtime Reference

## PubSub

Source: `packages/backend/src/services/pubsub.ts`

Redis-backed cross-process event bus. Falls back to in-process `EventEmitter` when no Redis is configured.

### Architecture

- 3 ioredis connections: read (subscriber), write (publisher), lock (Redlock)
- Publishes JSON arrays to a single `"events"` Redis channel
- Subscribers receive events and dispatch to local listeners
- In-process fallback uses `AsyncLock` instead of Redlock

### Distributed Locking

```typescript
const unlock = await lock(`processing:${id}`);
try {
  // ... exclusive work
} finally {
  await unlock();
}
```

- Redlock with 25 retries, 300ms delay, random jitter
- Falls back to `AsyncLock` when no Redis

### Usage in Hooks

```typescript
hook.after(Post, "save", async ({ model, lock, enqueue }) => {
  const unlock = await lock(`index:${model.id}`);
  try {
    await enqueue("post:index", { postId: model.id });
  } finally {
    await unlock();
  }
});
```

`lock()` and `enqueue()` are injected into hook context automatically.

## QuerySubscriptionManager

Source: `packages/backend/src/services/subscriptions.ts`

The heart of realtime list updates.

### Subscription Lifecycle

1. **Client subscribes** -- Frontend `useQuery()` calls `chain.find()`. The auto-CRUD LIST endpoint detects a socket connection and subscribes it.

2. **Hash generation** -- SHA-256 of `[modelType, querySteps, scopeSignature]`. Multiple sockets with the same query share one cache entry (ref-counted).

3. **Initial data** -- Server executes the query, caches results by ID, returns `{ items, __queryHash }` to client.

4. **Model change** -- `BackendAdapter.save()`/`patch()`/`remove()` calls `_notifyChange(modelType)`.

5. **Re-evaluation** -- Manager re-runs all queries watching that model type.

6. **Diff** -- Compares old vs new results:
   - **add**: New ID appeared in results
   - **remove**: ID disappeared from results
   - **update**: ID still present but data changed

7. **Emit** -- Sends ops to all subscribed sockets via `query:{hash}` event.

### Flow Diagram

```
Model.save() -> BackendAdapter.save() -> _notifyChange(type)
  -> QuerySubscriptionManager.onModelChange(type)
    -> for each query watching this type:
      -> re-execute query with same scope
      -> diff(oldResults, newResults)
      -> emit ops to all subscribed sockets
```

### Client-Side Processing

In `useQuery()`:

1. Initial data arrives, cached in global query store
2. Socket listens on `query:{hash}` for diff ops
3. Ops are pooled (debounced 100ms) and applied in batch
4. `applyOps()` returns a new array (immutable)
5. `useSyncExternalStore` triggers React re-render

### Cache Management

- Entries are ref-counted (multiple `useQuery()` calls with same query share one entry)
- 60s GC timeout after last subscriber unmounts
- Auth changes (`authenticated` event on AuthGate) clear entire query cache

## Socket.IO RPC Bridge

Source: `packages/backend/src/server.ts`

Socket calls are piped through Polka's HTTP handler using fake req/res objects:

```typescript
socket.on("call", async (requestId, method, path, data) => {
  const fakeReq = {
    method,
    url: path,
    body: data,
    query: method === "GET" ? data : {},
    session: socket.session, // Auth session from "authenticate" event
    socket, // Original socket reference
    headers: {},
  };

  const fakeRes = {
    // Captures response, compresses with gzip + compress-json
    // Emits back to socket via requestId event
  };

  server.polka.handler(fakeReq, fakeRes);
});
```

This means socket calls go through the same middleware, auth, and route handlers as HTTP calls. A single route definition serves both transports.

### Socket Connection Flow

1. Client connects via Socket.IO
2. Client sends `"authenticate"` event with token
3. Server calls `auth.resolveToken(token)` -> sets `socket.session`
4. Server responds with `{ userId }` or `{ error }`
5. Client's AuthGate transitions to `"authenticated"` or `"unauthenticated"`
6. All queued requests now execute (they were awaiting `auth.ready`)

### Response Compression

Server compresses responses for socket transport:

1. `compress-json.compress(data)` -- structural compression
2. `JSON.stringify()`
3. `pako.gzip()` -- binary compression

Client decompresses:

1. `pako.ungzip()` -> Uint8Array to string
2. `JSON.parse()`
3. `compress-json.decompress()`
