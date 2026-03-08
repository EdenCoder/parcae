# SDK Reference

Source: `packages/sdk/src/`

## createClient()

Source: `packages/sdk/src/client.ts`

```typescript
import { createClient } from "@parcae/sdk";

const client = createClient({
  url: "http://localhost:3000",
  transport: "socket", // "socket" (default) or "sse" or custom Transport
});
```

- **Idempotent**: Returns cached client for same `url:version` combo
- Calls `Model.use(new FrontendAdapter(transport))` automatically
- Stored on `globalThis` for cross-package sharing

### ParcaeClient API

```typescript
client.get(path, data?)          // GET request
client.post(path, data?)         // POST
client.put(path, data?)          // PUT
client.patch(path, data?)        // PATCH
client.delete(path, data?)       // DELETE
client.subscribe(channel)        // Subscribe to PubSub channel
client.unsubscribe(channel)      // Unsubscribe
client.send(event, ...args)      // Raw socket emit
client.authenticate(token)       // Send auth token
client.on(event, handler)        // Listen for events
client.off(event, handler)       // Remove listener
client.disconnect()              // Close connection
client.reconnect()               // Reconnect
```

## SocketTransport

Source: `packages/sdk/src/transports/socket.ts`

- Socket.IO over WebSocket
- Connection pooling: shared socket per `url:path` via global `SOCKETS` Map
- RPC via `"call"` event with unique request IDs (10-char ShortId)
- Response decompression: `pako.ungzip()` -> `JSON.parse()` -> `compress-json.decompress()`
- GET request deduplication (in-flight coalescing via `inflight` Map)
- 30s timeout for pending requests
- Auth via `"authenticate"` event with callback
- `AuthGate` integration: all requests `await this.auth.ready` before executing

## SSETransport

Source: `packages/sdk/src/transports/sse.ts`

- Standard `fetch()` for request/response
- `EventSource` per subscription channel at `/__events/{event}`
- Control messages via POST to `/__control`
- Bearer token auth via `Authorization` header
- No compression (relies on HTTP gzip)
- "Always connected" semantics

## AuthGate

Source: `packages/sdk/src/auth-gate.ts`

Valtio-reactive auth state machine:

```typescript
class AuthGate {
  state = proxy<AuthState>({
    status: "pending" | "authenticated" | "unauthenticated",
    userId: string | null,
    version: number, // increments on each auth change
  });

  ready: Promise<void>; // resolves when auth is determined

  resolve(userId): void;
  resolveUnauthenticated(): void;
  reset(): void;
}
```

Transport writes to AuthGate directly. React hooks read from it.

## AuthClientAdapter Interface

```typescript
interface AuthClientAdapter {
  init(baseUrl: string): void;
  getToken(): Promise<string | null>;
  onChange(callback: (token: string | null) => void): () => void;
}
```

Implementations: `@parcae/auth-betterauth/client`, `@parcae/auth-clerk/client`.

## React Integration

Source: `packages/sdk/src/react/`

### ParcaeProvider

Source: `packages/sdk/src/react/Provider.tsx`

```tsx
import { ParcaeProvider } from "@parcae/sdk/react";
import { betterAuth } from "@parcae/auth-betterauth/client";

<ParcaeProvider
  url="http://localhost:3000"
  auth={betterAuth()} // AuthClientAdapter
  transport="socket" // or "sse"
  onReady={(client) => {}}
  onError={(err) => {}}
>
  <App />
</ParcaeProvider>;
```

- Creates client via `createClient()` or accepts pre-created `client` prop
- Initializes auth adapter, resolves session, calls `client.authenticate(token)`
- Re-authenticates on socket reconnect
- Subscribes to auth adapter `onChange` for login/logout

### useQuery

Source: `packages/sdk/src/react/useQuery.ts`

```tsx
const { items, loading, error, refetch } = useQuery(
  Post.where({ published: true }).orderBy("createdAt", "desc"),
);
```

**How it works:**

1. Generates cache key: `modelType:authVersion:JSON(steps)`
2. Calls `chain.find()` to fetch initial data
3. Backend response includes `__queryHash` -- subscribes to `query:{hash}` socket event
4. Server pushes surgical diff ops: `{ op: "add"|"remove"|"update", id, data }`
5. Ops applied immutably via `applyOps()`
6. Uses `useSyncExternalStore` for tear-safe rendering
7. Global query cache with ref counting + 60s GC timeout

Pass `null`/`undefined` to skip: `useQuery(userId ? Post.where({user: userId}) : null)`

Waits for auth by default (`waitForAuth: true`).

**Return value:**

| Field     | Type            | Description              |
| --------- | --------------- | ------------------------ |
| `items`   | `T[]`           | Array of model instances |
| `loading` | `boolean`       | True while fetching      |
| `error`   | `Error \| null` | Last error               |
| `refetch` | `() => void`    | Force refetch            |

### useApi

```tsx
const { get, post, put, patch, delete: del } = useApi();

const result = await get("/settings");
const created = await post("/characters", { name: "John" });
```

### useSDK

```tsx
const client = useSDK(); // Raw ParcaeClient instance
```

### useConnectionStatus

```tsx
const { isConnected, authStatus } = useConnectionStatus();
// authStatus: "pending" | "authenticated" | "unauthenticated"
```

### useSetting

```tsx
const [theme, setTheme, { isLoading }] = useSetting("theme", "light");
// Optimistic local update + server sync
// Requires a Setting model with key/value pattern
```

### Auth Gate Components

```tsx
import { Authenticated, Unauthenticated, AuthLoading } from "@parcae/sdk/react";

<Authenticated>Welcome back!</Authenticated>
<Unauthenticated>Please log in</Unauthenticated>
<AuthLoading>Connecting...</AuthLoading>
```

Conditional rendering based on auth state. Uses AuthGate's Valtio state internally.
