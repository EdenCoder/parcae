# @parcae/sdk

Client SDK for Parcae backends. It provides a Socket.IO transport, explicit
connection and session state, and React hooks for realtime model queries.

## Install

```bash
npm install @parcae/sdk @parcae/model
```

## Create a client

```typescript
import { createClient } from "@parcae/sdk";

const client = createClient({
  url: "https://api.example.com",
  getToken: async () => auth.getToken(), // return null for anonymous
});
```

`getToken` is required. The client sends its result in the server-confirmed
`hello` handshake on initial connection, reconnect, and explicit session
refresh.

```typescript
interface ClientConfig {
  url: string;
  version?: string; // default: "v1"
  getToken: () => Promise<string | null>;
  transports?: ("websocket" | "polling")[]; // default: ["websocket"]
  extraHeaders?: Record<string, string>;
}
```

`extraHeaders` apply in Node and React Native. Browsers cannot attach custom
headers to WebSocket upgrades.

`createClient` caches one primary client for the exact structured
`(url, version)` identity. A realm may have only one primary Model client:
requesting a different URL/version fails before a second socket is created and
directs the caller to `createIsolatedClient`. Reuse is permitted only when
`transports` and `extraHeaders` match the original immutable configuration.
Incompatible reuse fails closed. Each client owns its physical socket; sockets
are not pooled between clients.

The client installs a `FrontendAdapter` for `@parcae/model`, so model queries
use this transport.

## Client API

```typescript
interface ParcaeClient {
  transport: Transport;
  session: SessionMachine;
  connection: ConnectionMachine;

  get(path, data?, options?): Promise<unknown>;
  post(path, data?, options?): Promise<unknown>;
  put(path, data?, options?): Promise<unknown>;
  patch(path, data?, options?): Promise<unknown>;
  delete(path, data?, options?): Promise<unknown>;

  subscribe(event, handler): () => void;
  unsubscribe(event, handler?): void;
  send(event, ...args): void;
  on(event, handler): void;
  off(event, handler?): void;

  refreshSession(): Promise<{ userId: string | null }>;
  terminateSession(): Promise<void>;
  resync(entries): Promise<ResyncResult[]>;

  readonly isConnected: boolean;
  disconnect(): void;
  reconnect(): Promise<void>;
}
```

`refreshSession()` begins a closed authorization boundary, cancels pending
RPC, resync, and connection-wait work from the previous authorization
generation, reads the latest token, and waits for the matching `hello`
acknowledgement. `terminateSession()` performs the equivalent fail-closed
sign-out boundary. Authorization boundaries detach and release custom
subscription handlers; late acknowledgements and callbacks from a prior
generation cannot cross into the new session.

Connection and session state are intentionally separate. A network disconnect
does not silently change the authenticated identity.

## Isolated clients

An active `ParcaeProvider` owns its cached client's token resolver. A direct
`createClient()` call cannot replace that resolver. For one-shot or background
work, use an isolated client with its own socket:

```typescript
import { withIsolatedClient } from "@parcae/sdk";

await withIsolatedClient({ url, getToken }, (isolated) =>
  isolated.post("/jobs/run", {}),
);
```

`withIsolatedClient` does not replace the global Model adapter and always
disconnects in `finally`. Client-aware `prefetch`/`useQuery` replay lazy or
foreign-adapter chains through the exact supplied client, but a direct static
`Post.where(...).find()` outside those APIs still uses the one primary global
adapter. Prefer the isolated client's HTTP methods for one-shot work.

## React

### ParcaeProvider

```tsx
import { ParcaeProvider } from "@parcae/sdk/react";

<ParcaeProvider url="https://api.example.com" auth={authAdapter}>
  <App />
</ParcaeProvider>;
```

You may instead pass a pre-created `client`. When an external client is paired
with `auth`, it must support session reconciliation.

The provider constructs an internal client only after a committed layout
effect, so an abandoned React render cannot create a socket or replace the
Model adapter. It keeps children unmounted while the session is pending. Auth
changes purge the exact previous `(client, owner)` query cache and keep the
tree closed until the server confirms the current token. Unmounting a provider
that owns the resolver purges its owner cache, terminates the session, and
disconnects the socket.

### useQuery

```tsx
import { useQuery } from "@parcae/sdk/react";

function PostList() {
  const { items, loading, error } = useQuery(
    Post.where({ published: true }).orderBy("createdAt", "desc"),
  );

  if (loading) return <p>Loading…</p>;
  if (error) return <p>{error.message}</p>;
  return items.map((post) => <article key={post.id}>{post.title}</article>);
}
```

The query cache uses an opaque structured identity containing:

- the exact client instance;
- the exact owner ID, including anonymous ownership;
- model type and serialized query steps; and
- subscribed or static mode.

Entries are shared only inside that complete identity and are garbage
collected 60 seconds after the final reference is released. Authorization
boundaries synchronously scrub and remove the previous owner's entries.
Pending fetch, retry, subscription, and resync continuations cannot repopulate
a disposed entry. Final-reference GC sends one `unsubscribe:query` only while
the same owner/session version is still reconciled; boundary cleanup never
sends a stale-session unsubscribe through its replacement.

Reconnect resync results carry an `authorized` flag. A denied, missing, or
failed result scrubs prior arrays in place, detaches the old listener, and
fails closed instead of preserving stale PHI. A later mount or prefetch
refetches a denied dynamic entry after its subscription hash is cleared.

Pass `null` or `undefined` to skip a query. Use `{ subscribe: false }` for a
static fetch, or `prefetch(client, chain)` to warm the same owner-scoped cache.
Prefetch waits for the current session reconciliation by default.

### Other hooks

- `useApi()` returns bound HTTP methods.
- `useSocket()` exposes session-fenced custom event `emit`, `on`, and `off`.
- `useSession()` returns identity state.
- `useConnection()` returns wire state.
- `useModel()`, `useModelAtomic()`, and `useModelsAtomic()` subscribe to model
  changes.
- `useSetting()` manages persistent user settings.
- `useSaving()` tracks save state.
- `Authenticated`, `Unauthenticated`, and `SessionLoading` gate by session
  status.

## Transport protocol

The SDK uses Socket.IO, normally over WebSocket. Polling can be selected for
runtimes without a WebSocket global.

- `hello` binds the socket to the token resolved by `getToken`.
- `call` carries version-prefixed HTTP-style RPC.
- `resync` restores live query subscriptions after a confirmed reconnect.
- `query:<hash>` carries realtime query operations.

RPC and resync default to a 120-second timeout. Each authorization boundary
invalidates prior work even when the user ID is unchanged, such as a role or
claims rotation.

## Exports

```typescript
import {
  ConnectionMachine,
  SessionMachine,
  SocketTransport,
  createClient,
  createIsolatedClient,
  withIsolatedClient,
} from "@parcae/sdk";
import type {
  AuthClientAdapter,
  ClientConfig,
  ParcaeClient,
  SocketTransportConfig,
} from "@parcae/sdk";

import {
  Authenticated,
  ParcaeProvider,
  SessionLoading,
  Unauthenticated,
  prefetch,
  useApi,
  useConnection,
  useModel,
  useModelAtomic,
  useModelsAtomic,
  useParcae,
  useQuery,
  useSaving,
  useSession,
  useSetting,
  useSocket,
} from "@parcae/sdk/react";
```

## License

MIT
