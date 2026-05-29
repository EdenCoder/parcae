# SDK Reference

Source: `packages/sdk/src/`

The SDK is the browser/React-side client for a Parcae backend. There is exactly one
transport — `SocketTransport` (Socket.IO over WebSocket). It owns three orthogonal
concerns: the socket, a `ConnectionMachine` (is the wire usable?), and a
`SessionMachine` (who is the user?). Connection and session lifetimes are
independent — a TCP blip never signs anyone out, and a sign-out never drops the
socket.

## createClient()

Source: `packages/sdk/src/client.ts`

```typescript
import { createClient } from "@parcae/sdk";

const client = createClient({
  url: "http://localhost:3000",
  version: "v1",            // optional, defaults to "v1"
  getToken: async () => {   // REQUIRED — return the bearer token, or null for anonymous
    return localStorage.getItem("token");
  },
});
```

```typescript
interface ClientConfig {
  url: string;
  version?: string;                       // default "v1"
  getToken: () => Promise<string | null>; // required; null = anonymous
}
```

- `getToken` is **required**. It is called once before the initial `hello` and again on
  every reconnect / token rotation. Returning `null` means an anonymous session.
- **Idempotent**: returns a cached client for the same `${url}:${version ?? "v1"}` key.
  The cache lives on `globalThis.__parcae_clients` (a `Map`) so multiple copies of the
  package share one client.
- Calls `Model.use(new FrontendAdapter(transport))` automatically, wiring the model
  layer to this transport.
- There is **no** `transport` option — `SocketTransport` is hard-wired.

### ParcaeClient surface

```typescript
interface ParcaeClient {
  transport: Transport;
  session: SessionMachine;
  connection: ConnectionMachine;

  get(path, data?, options?): Promise<any>;    // RequestOptions: { timeout?: number }
  post(path, data?, options?): Promise<any>;
  put(path, data?, options?): Promise<any>;
  patch(path, data?, options?): Promise<any>;
  delete(path, data?, options?): Promise<any>;

  subscribe(event, handler): () => void;       // returns an unsubscribe fn
  unsubscribe(event, handler?): void;
  send(event, ...args): void;                  // raw socket.emit
  on(event, handler): void;
  off(event, handler?): void;

  readonly isConnected: boolean;               // connection.status === "connected"

  refreshSession(): Promise<{ userId: string | null }>;  // sign-in / token rotation
  terminateSession(): Promise<void>;                       // explicit sign-out
  resync(entries: ResyncEntry[]): Promise<ResyncResult[]>; // batched subscription restore

  disconnect(): void;
  reconnect(): Promise<void>;
}
```

There is **no** `authenticate(token)` method. Sign-in / token rotation is
`refreshSession()`; sign-out is `terminateSession()`. `subscribe()` returns an
unsubscribe function (unlike `unsubscribe()` / `off()`, which are imperative).

Paths are version-prefixed automatically: a call to `client.get("/posts")` is emitted
as `GET /v1/posts`.

## SocketTransport

Source: `packages/sdk/src/transports/socket.ts` (exported as `SocketTransport`)

- Socket.IO, **WebSocket transport only** (`transports: ["websocket"]`), with
  `withCredentials: true`. Default socket path is **`/ws`** (overridable via the
  internal `path` config; `createClient` does not expose it).
- **Socket pooling**: one shared socket per `${url}:${path}` via a module-level
  `SOCKETS` Map.
- **Handshake**: on `connect`, emits `"hello"` with `{ token }` (token from
  `getToken()`); the server acks `{ userId }`. The transport calls
  `session.resolve(userId)` and resolves an internal `helloReady` promise. Every
  successful hello also emits a `"resync-required"` event.
- **All requests `await helloReady`** before going out, guaranteeing the socket is
  authenticated first. `helloReady` resolves once and stays resolved until the next
  reconnect kicks a fresh handshake.
- If `getToken()` throws, the handshake aborts and re-throws — the session stays
  `pending` (a failed token read is treated as transient infra failure, **not** as an
  anonymous session, to avoid 403 storms).
- **RPC**: emits `"call"` with `(id, METHOD, "/<version><path>", data)`, where `id` is a
  10-char ShortId. Response lands on the `id` event.
- **Response decode**: `pako.ungzip(msg, { to: "string" })` → `JSON.parse` →
  `compress-json` `decompress()`. Resolves `parsed.result` when `parsed.success`,
  otherwise rejects with `parsed.message || parsed.error`.
- **GET deduplication**: in-flight GETs are coalesced by `${path}:${JSON.stringify(data)}`
  via an `inflight` Map.
- **Timeout**: `DEFAULT_TIMEOUT` is **120_000 ms** (120 s) for RPC calls and resync,
  overridable per call via `options.timeout`.
- **Disconnect does NOT touch session state.** Only `connection` transitions on socket
  lifecycle events.
- `reconnect()` is a no-op if already connected; otherwise sets `connection.connecting()`
  and calls `socket.connect()`.
- `_resetSockets()` is exported as an `@internal` test helper.

### resync RPC

Used by `useQuery` after every (re)connect to restore server-side query subscriptions
in one round trip.

```typescript
interface ResyncEntry {
  key: string;
  modelType: string;
  steps: unknown[];
  queryHash?: string | null;   // last-known hash; server can skip unchanged subs
}
interface ResyncResult {
  key: string;
  hash: string;
  items: any[];
  totalCount: number;
}
```

Wire shape: emits `"resync"` with `{ queries: entries }`, acks `{ results }`. Returns
`[]` immediately for an empty entry list.

## SessionMachine

Source: `packages/sdk/src/session-machine.ts`

*Who is this user?* Identity-only. Lifetime is the token's lifetime, not the socket's.
Plain listener `Set` + monotonic `version` — **no Valtio**.

```typescript
type SessionStatus = "pending" | "anonymous" | "authenticated" | "terminated";

interface SessionState {
  status: SessionStatus;
  userId: string | null;
  version: number;        // bumped on every change
}

class SessionMachine {
  state: SessionState;          // initial { status: "pending", userId: null, version: 0 }
  ready: Promise<void>;         // resolves the first time status leaves "pending"
  subscribe(fn: () => void): () => void;
  resolve(userId: string | null): void;  // → "authenticated" (userId) or "anonymous" (null)
  terminate(): void;                       // → "terminated" (explicit sign-out)
  reset(): void;                           // → "pending" (internal/diagnostic; re-arms ready)
}
```

- `resolve()` is a no-op when status is `terminated`, and no-ops (no notify) when the
  result confirms the current `(status, userId)`.
- `terminate()` is sticky: once terminated, `resolve()` is ignored until `reset()`.
  `refreshSession()` in the transport calls `reset()` first if the session was
  terminated, supporting sign-out → sign-in-again on a reused client.
- Only three callers mutate session: the transport's `hello` ack, the auth adapter's
  `onChange`, and `terminate()`. Socket connect/disconnect/error never touch it.

## ConnectionMachine

Source: `packages/sdk/src/connection-machine.ts`

*Is the wire usable right now?* Pure transport-state. No identity, no Valtio.

```typescript
type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected";

interface ConnectionState {
  status: ConnectionStatus;
  lastError: Error | null;
  version: number;
  lastConnectedAt: number | null;   // wall-clock ms of last "connected"
}

class ConnectionMachine {
  state: ConnectionState;          // initial { status: "idle", ... }
  subscribe(fn: () => void): () => void;
  connecting(): void;
  connected(): void;
  disconnected(err?: Error | null): void;
}
```

## AuthClientAdapter

Source: `packages/sdk/src/auth-adapter.ts`

The adapter is the source of truth for the current bearer token. `ParcaeProvider` builds
the client's `getToken` from it.

```typescript
interface AuthClientAdapter {
  init(baseUrl: string): void;
  getToken(): Promise<string | null>;                 // null = anonymous
  onChange(callback: (token: string | null) => void): () => void;
}
```

`onChange` fires on sign-in (non-null token), sign-out (null), and rotation (different
non-null token). The Provider routes non-null → `client.refreshSession()`, null →
`client.terminateSession()`. Implementations live in `@parcae/auth-betterauth/client`
and `@parcae/auth-clerk/client`.

## React Integration

Source: `packages/sdk/src/react/` (import from `@parcae/sdk/react`)

### ParcaeProvider

Source: `packages/sdk/src/react/Provider.tsx`

```tsx
import { ParcaeProvider } from "@parcae/sdk/react";
import { betterAuth } from "@parcae/auth-betterauth/client";

<ParcaeProvider
  url="http://localhost:3000"
  auth={betterAuth()}          // AuthClientAdapter (optional; omitted = anonymous)
  version="v1"
  onReady={(client) => {}}     // fires once when the session leaves "pending"
  onError={(err) => {}}
>
  <App />
</ParcaeProvider>;
```

```typescript
interface ParcaeProviderProps {
  client?: ParcaeClient;       // pre-created client (overrides url/auth/version)
  url?: string;                // required unless `client` is given
  auth?: AuthClientAdapter;
  version?: string;            // default "v1"
  children: React.ReactNode;
  onReady?: (client: ParcaeClient) => void;
  onError?: (error: Error) => void;
}
```

There is **no** `transport` prop. The Provider:

- Builds `getToken` from the `auth` adapter (`auth.init(url)` then `auth.getToken()`), or
  uses a `() => null` no-op when no adapter is given, and creates the client via
  `createClient` (or uses the `client` prop directly).
- **The session-lifecycle effect below only runs when an `auth` adapter is supplied**
  (`if (!auth) return`). With `auth` omitted (anonymous), `onReady` never fires and none of
  the `onChange` routing or cache-purge happens.
- Fires `onReady(client)` exactly once, the first time `session.status` leaves
  `"pending"`.
- Subscribes to `auth.onChange`: non-null token → `refreshSession()`, null →
  `terminateSession()`.
- Purges the per-user `useQuery` cache for the previous user whenever the session `userId`
  changes away from a non-null value — i.e. on a user switch **and** on sign-out
  (non-null → null).
- Listens for `"resync-required"` and drives `useQuery`'s batched resync; forwards
  transport `"error"` events to `onError`.

### useQuery

Source: `packages/sdk/src/react/useQuery.ts`

```tsx
const { items, loading, error, total, refetch } = useQuery(
  Post.where({ published: true }).orderBy("createdAt", "desc").limit(100),
);
```

```typescript
function useQuery<T>(
  chain: QueryChain<T> | null | undefined,
  options?: { poll?: number },   // drift-refetch interval ms; default 60_000, 0 disables
): UseQueryResult<T>;

interface UseQueryResult<T> {
  items: T[];
  loading: boolean;
  error: Error | null;
  total: number;                                  // server total before limit/offset
  refetch: () => void;
  addOptimistic: (item: T | Record<string, any>) => T;
  removeOptimistic: (item: T | string) => void;
  onOps: (listener: (ops: QueryOp[]) => void) => () => void;
}
```

**The default `.limit(25)` footgun.** The **backend** injects a default `.limit(25)` when
the client query specifies no `.limit()` (source:
`packages/backend/src/adapters/model.ts`, `DEFAULT_LIMIT = 25`). List / calendar / grid
views that omit a limit **silently truncate to 25 rows**. Always pass an explicit
`.limit(N)` for views that need more, or narrow with filters. `.limit(0)` is **not**
unlimited — the backend sanitizes it to `Math.max(0 || 25, 1)` = 25, i.e. it falls back
to the default. To genuinely disable the cap use `.clearLimit()` (which the backend caps
at 10,000 as a safety net).

**How it works:**

1. Waits for the session to resolve: while `session.status === "pending"` the query is
   inert (`loading: true`, no fetch). Once it resolves it builds the cache key
   `modelType:userId:JSON(steps)` (anonymous userId → `anon`).
2. Calls `chain.find()` for the initial data.
3. The backend response carries `__queryHash` (and `__totalCount`). The hook subscribes
   to the `query:<hash>` socket event.
4. The server streams diff ops. The op shape is:
   ```typescript
   type QueryOp =
     | { op: "add";    id: string; data: Record<string, any> }
     | { op: "remove"; id: string }
     | { op: "update"; id: string; patch: Operation[] };  // RFC 6902 JSON Patch
   ```
   Update patches are RFC 6902 JSON Patch applied via `fast-json-patch`. An optional
   `order: string[]` envelope reorders rows.
5. **`update`-only frames keep the `items` array reference stable.** They mutate the model
   instances in place (via `SYM_SERVER_MERGE`); the `items` array identity does **not**
   change, so child components memoized on the array don't reconcile. `useQuery` itself
   still re-renders (the entry's version bumps and its snapshot hash changes), so for
   field-level reactivity in a row, read the fields through `useModel(item)` (or
   `useModelAtomic`) rather than relying on the parent's `useQuery` re-render.
6. Uses `useSyncExternalStore` for tear-safe rendering, backed by a global query cache
   with **ref-counting and a 60 s GC timeout** after the last subscriber unmounts.
7. On reconnect the Provider calls the batched `resync` RPC to restore subscriptions for
   all live entries in one round trip.
8. Failed fetches retry up to 3 times with backoff (`[1s, 3s, 10s]`).

**Skip / conditional:** pass `null`/`undefined` to skip:
`useQuery(userId ? Post.where({ user: userId }) : null)`.

**Polling:** `poll` is a drift-detection refetch interval (default `60_000` ms, `0`
disables). It pauses while the tab is hidden (`visibilitychange`) or the transport is
disconnected, and resumes/ticks immediately when the tab becomes visible.

**Optimistic helpers:** `addOptimistic(item)` inserts a local instance (assigning a `tmp`
id) that is reconciled away when the matching server `add` arrives;
`removeOptimistic(item | id)` drops it. `onOps(listener)` subscribes to the raw op stream.

### prefetch

Source: `packages/sdk/src/react/useQuery.ts`

Imperatively warm the `useQuery` cache (e.g. on route load) so the component mounts with
data already present.

```typescript
function prefetch<T>(
  client: ParcaeClient,
  chain: QueryChain<T>,
  options?: { waitForSession?: boolean },  // default true → await client.session.ready
): Promise<T[]>;
```

Builds the same `modelType:userId:JSON(steps)` cache key, takes a ref on the entry, and
resolves once the first fetch settles. Throws if the chain has no `__modelType`.

### useApi / useSDK

Source: `packages/sdk/src/react/useApi.ts`

```tsx
const { get, post, put, patch, delete: del } = useApi();

const result = await get("/settings");
const created = await post("/posts", { title: "Hello" });
```

```tsx
const client = useSDK(); // raw ParcaeClient instance (alias for useParcae())
```

### useSession / useConnection

Source: `packages/sdk/src/react/useSession.ts`, `useConnection.ts`

The modern, split state hooks. Each re-renders only on its own machine's transitions.

```tsx
const { status, userId } = useSession();
// status: "pending" | "anonymous" | "authenticated" | "terminated"

const { status, isConnected, lastError, lastConnectedAt } = useConnection();
// status: "idle" | "connecting" | "connected" | "disconnected"
```

### useConnectionStatus (legacy)

Source: `packages/sdk/src/react/useApi.ts`

Combined snapshot kept for legacy call sites. Prefer `useSession()` / `useConnection()`.
Note the field is `sessionStatus`, not `authStatus`.

```tsx
const { isConnected, sessionStatus } = useConnectionStatus();
// sessionStatus: "pending" | "anonymous" | "authenticated" | "terminated"
```

### useModel / useModelAtomic / useModelsAtomic

Source: `packages/sdk/src/react/useModel.ts`, `useModelAtomic.ts`

`useModel(model)` re-renders the component whenever **any** data property on `model`
mutates (driven by the model's `"change"` event). Pairs with `useQuery` for row-level
reactivity:

```tsx
function Row({ post }: { post: Post }) {
  useModel(post);
  return <div>{post.title}</div>;
}
```

`useModelAtomic(model, path, compareFnOrOptions?, options?)` re-renders **only** when the
value at a dot-notation `path` changes (`"video.url"`, `"items.0.name"`). Returns the
value at that path. The default comparator is structural deep equality
(`@observ33r/object-equals`; the module-internal `defaultEqual` is not re-exported from
`@parcae/sdk/react`) — necessary because the server-merge path deep-clones, so `Object.is`
on a sub-path would fire on every push.
Options: `{ compareFn, debounce, coalesced }` (`coalesced` batches notifications to one
per animation frame via the shared `scheduleCoalesced` / `cancelCoalesced` batcher).

`useModelsAtomic(models, path, ...)` reads the same `path` from N models in one
rules-of-hooks-safe call, returning an identity-stable array.

All three accept `null`/`undefined` (inert) and tolerate plain-object projections that
lack the model EventEmitter surface (no-op subscription).

### useSocket

Source: `packages/sdk/src/react/useSocket.ts`

Raw Socket.IO access over the existing authenticated connection.

```tsx
const socket = useSocket(); // { emit, on, off }

useEffect(() => socket.on("chat:chunk", (d) => {/* ... */}), []);
socket.emit("chat:message", { text: "hello" });
```

`on()` returns an unsubscribe function. `emit`/`on`/`off` delegate to
`client.send`/`subscribe`/`unsubscribe`.

### useSaving

Source: `packages/sdk/src/react/useSaving.ts`

Returns `true` while a model has in-flight save/patch operations. Reads
`model.__savingCount` and listens for the model's `"__saving"` event.

```tsx
const saving = useSaving(post);
```

### useSetting

Source: `packages/sdk/src/react/useSetting.ts`

```tsx
const [theme, setTheme, { isLoading }] = useSetting("theme", "light");
```

- Optimistic local update, then server sync.
- Loads via `GET /settings/{key}` and writes via `PUT /settings/{key}` with
  `{ value }`. Requires a backend `Setting`-style resource keyed by `key`/`value`.
- Only fetches when the session is `authenticated`; stays at the default value otherwise.

### Session Gate Components

Source: `packages/sdk/src/react/gates.tsx`

```tsx
import { Authenticated, Unauthenticated, SessionLoading } from "@parcae/sdk/react";

<Authenticated fallback={<Login />}>Welcome back!</Authenticated>
<Unauthenticated>Please log in</Unauthenticated>
<SessionLoading>Connecting…</SessionLoading>
```

Each gate reads `useSession()` (the `SessionMachine` status, **not** Valtio) and accepts
a `fallback` prop (default `null`):

| Component        | Renders `children` when status is | else renders `fallback` |
| ---------------- | --------------------------------- | ----------------------- |
| `Authenticated`  | `"authenticated"`                 | `fallback`              |
| `Unauthenticated`| `"anonymous"`                     | `fallback`              |
| `SessionLoading` | `"pending"`                       | `fallback`              |

The export is `SessionLoading` (there is no `AuthLoading`).
