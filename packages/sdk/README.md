# @parcae/sdk

Client SDK for Parcae backends. Socket.IO transport with a hello/resync handshake, React provider, and hooks for realtime data fetching.

## Install

```bash
npm install @parcae/sdk @parcae/model
```

## Create a Client

```typescript
import { createClient } from "@parcae/sdk";

const client = createClient({
  url: "http://localhost:3000",
  getToken: async () => localStorage.getItem("token"),
});
```

`createClient()` creates an independent Socket.IO transport, session machine, connection machine, and `FrontendAdapter`. It does not mutate the default model adapter. Use `client.bind(ModelClass)` for imperative model operations; `useQuery` automatically runs model chains through its provider client.

```typescript
const ClientPost = client.bind(Post);
const posts = await ClientPost.where({ published: true }).find();

const adminClient = createClient({ url, getToken: getAdminToken });
const AdminPost = adminClient.bind(Post); // independent from ClientPost
```

### ClientConfig

```typescript
interface ClientConfig {
  url: string;
  version?: string; // default: "v1"
  /**
   * Token resolver — called once before the initial hello and once
   * per reconnect. Return `null` for anonymous sessions.
   */
  getToken: () => Promise<string | null>;
  /**
   * socket.io transports list. Defaults to ["websocket"].
   * Pass ["polling"] on runtimes without a WebSocket global.
   */
  transports?: ("websocket" | "polling")[];
}
```

### ParcaeClient

`createClient()` returns a `ParcaeClient`:

```typescript
interface ParcaeClient {
  transport: Transport;
  adapter: FrontendAdapter;
  session: SessionMachine; // authenticated identity state
  connection: ConnectionMachine; // transport connection state

  // HTTP-style RPC (delegated to transport)
  get(path, data?, options?): Promise<any>;
  post(path, data?, options?): Promise<any>;
  put(path, data?, options?): Promise<any>;
  patch(path, data?, options?): Promise<any>;
  delete(path, data?, options?): Promise<any>;

  // Realtime pub/sub
  subscribe(event, handler): () => void;
  unsubscribe(event, handler?): void;
  send(event, ...args): void;

  // Connection state
  readonly isConnected: boolean;
  on(event, handler): void;
  off(event, handler?): void;
  disconnect(): void;
  reconnect(): Promise<void>;

  // Explicit model context and permanent teardown
  bind<T extends typeof Model>(model: T): T;
  dispose(): void;

  // Session lifecycle
  refreshSession(): Promise<{ userId: string | null }>;
  terminateSession(): Promise<void>;
  resync(entries: ResyncEntry[]): Promise<ResyncResult[]>;
}
```

Each `createClient()` call owns its own transport and authentication context. Reuse a client deliberately when callers should share identity and connection state; create and bind a separate client when they should not.

## Transport

### SocketTransport

The only built-in transport. Socket.IO over WebSocket.

- Bidirectional communication
- One socket owned by each client
- Hello/resync handshake — server confirms `userId` on every connect/reconnect
- Request/response via `"call"` event with short unique request IDs
- gzip + `compress-json` response encoding (`pako.ungzip` → `JSON.parse` → `compress-json.decompress`)
- GET request deduplication (in-flight coalescing)
- 120s default timeout for pending requests, overridable per request
- Token rotation triggers `refreshSession()`; explicit sign-out triggers `terminateSession()`

Pass `transports: ["polling"]` in `ClientConfig` for runtimes without a WebSocket global (e.g. some React Native shells).

The session and wire lifecycles are deliberately separate. A disconnect changes `ConnectionMachine` state but keeps the confirmed identity. Reconnect resolves the latest token, sends a fresh `hello`, then emits `resync-required` so live queries can restore their subscriptions. `refreshSession()` handles login/token rotation, `terminateSession()` handles explicit sign-out, and `dispose()` permanently removes listeners and closes the socket.

## React

### ParcaeProvider

Wrap your app in `ParcaeProvider` to make the client available to hooks.

```tsx
import { ParcaeProvider } from "@parcae/sdk/react";
import { betterAuth } from "@parcae/auth-betterauth/client";

// With inline config + auth adapter
<ParcaeProvider
  url="http://localhost:3000"
  auth={betterAuth({ baseUrl: "http://localhost:3000" })}
  transports={["websocket"]}
  onReady={(client) => console.log("ready", client.session.state)}
  onError={(err) => console.error(err)}
>
  <App />
</ParcaeProvider>

// Or with a pre-created client (auth handled out-of-band)
<ParcaeProvider client={client}>
  <App />
</ParcaeProvider>
```

`ParcaeProvider` resolves the initial session, subscribes to the auth adapter's `onChange` for token rotation / login / logout, and re-runs the hello handshake on socket reconnect. `auth` is optional — omit it for anonymous-only clients.

### useQuery

Reactive data fetching with realtime subscriptions. Returns typed model instances that update in place when the server pushes changes.

```tsx
import { useQuery } from "@parcae/sdk/react";

function PostList() {
  const { items, loading, error, refetch } = useQuery(
    Post.where({ published: true })
      .expand("user")
      .orderBy("createdAt", "desc"),
  );

  if (loading) return <p>Loading...</p>;
  if (error) return <p>Error: {error.message}</p>;

  return items.map((post) => (
    <article key={post.id}>
      <h2>{post.title}</h2>
      <span>{typeof post.user === "string" ? "" : post.user?.name}</span>
    </article>
  ));
}
```

**How it works:**

1. On mount, calls `chain.find()` to fetch initial data
2. Backend response includes a `__queryHash` — client subscribes to `query:{hash}` socket event
3. Postgres changes trigger a targeted cache refresh, with a full scoped-query fallback when required
4. Diff ops (`add`, `remove`, `update`) are pushed and applied client-side
5. Uses `useSyncExternalStore` for tear-safe rendering

**Caching:**

- Global query cache keyed by `modelType:authVersion:steps`
- Reference counting with 60s GC timeout after last subscriber unmounts
- A periodic drift poll (via `withForceRefresh()`) recovers from missed cross-process events

Pass `null` or `undefined` to skip the query:

```tsx
const { items } = useQuery(userId ? Post.where({ user: userId }) : null);
```

Pass `{ subscribe: false }` for static queries that don't need realtime push.

### useModel / useModelAtomic

Subscribe to a single model instance and re-render on change.

```tsx
import { useModelAtomic } from "@parcae/sdk/react";

function VideoPlayer({ block }: { block: Block }) {
  // Re-render ONLY when video.url changes — other field writes are skipped.
  const url = useModelAtomic(block, "video.url");
  return url ? <video src={url} /> : null;
}
```

`useModel` re-renders on any change to the model. `useModelAtomic(model, path)` narrows re-renders to a single dot-notation path (`"content"`, `"video.url"`, `"blocks.0.name"`). The default comparator is structural deep equality — pass `Object.is` as the third arg for hot primitive paths.

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

### useParcae

Raw client instance access.

```tsx
import { useParcae } from "@parcae/sdk/react";

const client = useParcae();
client.send("some:event", data);
```

### useConnection

Transport connection state.

```tsx
import { useConnection } from "@parcae/sdk/react";

function StatusBadge() {
  const { isConnected, status, lastError } = useConnection();
  // status: "idle" | "connecting" | "connected" | "disconnected"
  return <span>{isConnected ? "Online" : "Offline"}</span>;
}
```

### useSession

Authenticated identity state from `SessionMachine`.

```tsx
import { useSession, Authenticated, Unauthenticated, SessionLoading } from "@parcae/sdk/react";

function Account() {
  const { status, userId } = useSession();
  // status: "pending" | "anonymous" | "authenticated" | "terminated"
}

<Authenticated>Welcome back</Authenticated>
<Unauthenticated>Please sign in</Unauthenticated>
<SessionLoading>Connecting…</SessionLoading>
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
import {
  createClient,
  SocketTransport,
  SessionMachine,
  ConnectionMachine,
} from "@parcae/sdk";
import type {
  ClientConfig,
  ParcaeClient,
  SocketTransportConfig,
  ResyncEntry,
  ResyncResult,
  SessionState,
  SessionStatus,
  ConnectionState,
  ConnectionStatus,
} from "@parcae/sdk";

// React
import {
  ParcaeProvider,
  useParcae,
  useQuery,
  prefetch,
  useModel,
  useModelAtomic,
  useModelsAtomic,
  useApi,
  useSocket,
  useSetting,
  useSession,
  useConnection,
  useSaving,
  Authenticated,
  Unauthenticated,
  SessionLoading,
} from "@parcae/sdk/react";
```

`Model` and `FrontendAdapter` are not re-exported by `@parcae/sdk` — import them from `@parcae/model`.

## License

MIT
