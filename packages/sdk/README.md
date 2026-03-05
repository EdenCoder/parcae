# @parcae/sdk

Client SDK for Parcae backends. Pluggable transport layer (Socket.IO or SSE), React provider, and hooks for realtime data fetching.

## Install

```bash
npm install @parcae/sdk @parcae/model
```

## Create a Client

```typescript
import { createClient } from "@parcae/sdk";

// Socket.IO (default) — bidirectional, realtime subscriptions
const client = createClient({ url: "http://localhost:3000" });

// SSE — HTTP + Server-Sent Events, simpler infrastructure
const client = createClient({ url: "http://localhost:3000", transport: "sse" });

// Custom transport
const client = createClient({ url: "http://localhost:3000", transport: myTransport });
```

### ClientConfig

```typescript
interface ClientConfig {
  url: string;
  key?: string | null | (() => Promise<string | null>);
  version?: string;              // default: "v1"
  transport?: "socket" | "sse" | Transport;  // default: "socket"
}
```

### ParcaeClient

`createClient()` returns a `ParcaeClient` with the following API:

```typescript
interface ParcaeClient {
  // HTTP methods (delegated to transport)
  get(path, data?): Promise<any>;
  post(path, data?): Promise<any>;
  put(path, data?): Promise<any>;
  patch(path, data?): Promise<any>;
  delete(path, data?): Promise<any>;

  // Realtime
  subscribe(event, handler): () => void;
  unsubscribe(event, handler?): void;
  send(event, ...args): void;

  // Connection
  readonly isConnected: boolean;
  readonly isLoading: boolean;
  loading: Promise<void>;
  on(event, handler): void;
  off(event, handler?): void;
  disconnect(): void;
  reconnect(): Promise<void>;

  // Auth
  setKey(key): Promise<void>;
  readonly authVersion: number;
}
```

The client also calls `Model.use(new FrontendAdapter(transport))` automatically, so `Model.where()`, `Model.findById()`, and other static methods work immediately after creating a client.

## Transports

### SocketTransport

Default transport. Socket.IO over WebSocket.

- Bidirectional communication
- Connection pooling (shared socket per url:version)
- Request/response via `"call"` event with request IDs
- gzip + compress-json response encoding
- GET request deduplication (in-flight coalescing)
- 30s connection wait timeout for pending requests
- Auth via `"authenticate"` event

### SSETransport

HTTP + Server-Sent Events. Better for read-heavy workloads or environments where WebSocket is not available.

- Standard `fetch()` for request/response
- `EventSource` per subscription channel at `/__events/{event}`
- Control messages via POST to `/__control`
- Bearer token auth via `Authorization` header

## React

### ParcaeProvider

Wrap your app in `ParcaeProvider` to make the client available to hooks.

```tsx
import { ParcaeProvider } from "@parcae/sdk/react";

// With a pre-created client
const client = createClient({ url: "http://localhost:3000" });

<ParcaeProvider client={client}>
  <App />
</ParcaeProvider>

// Or with inline config
<ParcaeProvider
  url="http://localhost:3000"
  apiKey={token}
  userId={user.id}
  transport="socket"
  onReady={(client) => console.log("connected")}
  onError={(err) => console.error(err)}
>
  <App />
</ParcaeProvider>
```

Re-authenticates automatically when `userId` changes. Forwards transport errors via `onError`.

### useQuery

Reactive data fetching with realtime subscriptions. Returns typed model instances that update in place when the server pushes changes.

```tsx
import { useQuery } from "@parcae/sdk/react";

function PostList() {
  const { items, loading, error, refetch } = useQuery(
    Post.where({ published: true }).orderBy("createdAt", "desc")
  );

  if (loading) return <p>Loading...</p>;
  if (error) return <p>Error: {error.message}</p>;

  return items.map((post) => (
    <article key={post.id}>
      <h2>{post.title}</h2>
      <Suspense fallback="...">
        <span>{post.user.name}</span>
      </Suspense>
    </article>
  ));
}
```

**How it works:**

1. On mount, calls `chain.find()` to fetch initial data
2. Sends `subscribe:query` to the server with the serialized query steps
3. Server re-evaluates the query when matching models change
4. Diff ops (`add`, `remove`, `update`) are pushed and applied client-side
5. Uses `useSyncExternalStore` for tear-safe rendering

**Caching:**

- Global query cache keyed by `modelType:authVersion:steps`
- Reference counting with 60s GC timeout after last subscriber unmounts
- Debounced diff-op application (default 100ms)

Pass `null` or `undefined` to skip the query:

```tsx
const { items } = useQuery(userId ? Post.where({ user: userId }) : null);
```

### useApi

Pre-bound HTTP methods from the client.

```tsx
import { useApi } from "@parcae/sdk/react";

function UploadButton() {
  const { post } = useApi();

  const upload = async (file) => {
    const result = await post("/v1/media/upload", { file });
  };
}
```

### useSDK

Raw client instance access.

```tsx
import { useSDK } from "@parcae/sdk/react";

const client = useSDK();
client.send("some:event", data);
```

### useConnectionStatus

Connection state for the transport.

```tsx
import { useConnectionStatus } from "@parcae/sdk/react";

function StatusBadge() {
  const { isConnected, isLoading } = useConnectionStatus();

  if (isLoading) return <span>Connecting...</span>;
  return <span>{isConnected ? "Online" : "Offline"}</span>;
}
```

### useSetting

Persistent key-value user settings. GETs on mount, PUTs on update.

```tsx
import { useSetting } from "@parcae/sdk/react";

function ThemeToggle() {
  const [theme, setTheme, { isLoading }] = useSetting("theme", "light");

  return (
    <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
      {theme}
    </button>
  );
}
```

## Exports

```typescript
// Main
import { createClient, SocketTransport, SSETransport } from "@parcae/sdk";
import type { ClientConfig, ParcaeClient, Transport } from "@parcae/sdk";

// React
import {
  ParcaeProvider,
  useQuery,
  useApi,
  useSDK,
  useConnectionStatus,
  useSetting,
  useParcae,
} from "@parcae/sdk/react";

// Re-exports from @parcae/model
import { Model, FrontendAdapter } from "@parcae/sdk";
```

## License

MIT
