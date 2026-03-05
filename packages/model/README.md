# @parcae/model

The core Model system for Parcae. Class properties are the schema. Direct property access via Proxy with change tracking, lazy-loading references, and a pluggable adapter pattern that runs the same code on frontend and backend.

## Install

```bash
npm install @parcae/model
```

## Define a Model

```typescript
import { Model } from "@parcae/model";

class Post extends Model {
  static type = "post" as const;

  user!: User;              // reference -> VARCHAR storing ID
  title: string = "";       // string -> VARCHAR
  body: PostBody = {};      // object -> JSONB
  tags: string[] = [];      // array -> JSONB
  published: boolean = false; // boolean -> BOOLEAN
  views: number = 0;        // number -> INTEGER
}
```

No decorators, no separate schema definition, no Zod. The class properties _are_ the schema.

## Property Access

The Model constructor returns a Proxy. Data properties read/write to an internal store with automatic change tracking.

```typescript
const post = await Post.findById("abc");

post.title;              // "Hello" — reads from data store
post.title = "Updated";  // change tracked automatically
post.published;          // false — typed as boolean

await post.save();       // flushes tracked changes
```

## References

Properties typed as another Model class become lazy-loading proxies. The `$` prefix gives raw ID access.

```typescript
post.user;   // User proxy — loads on property access, Suspense-compatible
post.$user;  // "user_k8f2m9x" — raw string ID, no loading

// Setting a reference accepts a Model instance or raw ID
post.user = someUser;        // extracts someUser.id
post.$user = "user_abc123";  // sets raw ID directly
```

The reference proxy throws a Promise on first property access for React Suspense integration:

```tsx
<Suspense fallback={<span>Loading...</span>}>
  <span>{post.user.name}</span>
</Suspense>
```

## Static Query Methods

All query methods go through the global adapter set via `Model.use()`.

```typescript
// Find by ID
const post = await Post.findById("abc");

// Query builder
const published = await Post.where({ published: true })
  .orderBy("createdAt", "desc")
  .limit(10)
  .find();

// Other entry points
Post.whereIn("id", ["a", "b", "c"]);
Post.whereNot({ published: false });
Post.whereNotIn("status", ["draft", "archived"]);
Post.whereRaw("views > ?", 100);
Post.select("title", "views");
Post.count();

// Convenience: paginated, sorted
Post.basic(25, "createdAt", "desc", 0);
```

## Instance Methods

```typescript
// Create
const post = Post.create({ title: "New Post" });
post.id;  // auto-generated 20-char ID

// Save (insert or update)
await post.save();

// Save with debounce (frontend batching)
post.__debounceMs = 500;
post.title = "A";
post.title = "AB";    // batched into single save
await post.save();

// Atomic JSON Patch (RFC 6902)
await post.patch([
  { op: "replace", path: "/title", value: "Patched" },
  { op: "add", path: "/body/blocks/-", value: { type: "text" } },
]);

// Delete
await post.remove();

// Reload from adapter (skips in-flight changes)
await post.refresh();

// Serialize
post.toJSON();           // { type, id, title, ... }
await post.sanitize(user); // override in subclass to strip fields
```

## Query Chain

The `QueryChain<T>` interface supports 40+ chainable methods:

**Filtering:** `where`, `andWhere`, `orWhere`, `whereIn`, `whereNot`, `whereNotIn`, `whereNull`, `whereNotNull`, `whereBetween`, `whereRaw`, `orWhereRaw`, `orWhereIn`, `orWhereNull`, `whereExists`

**Ordering & Pagination:** `orderBy`, `orderByRaw`, `limit`, `offset`

**Selection & Grouping:** `select`, `distinct`, `distinctOn`, `groupBy`, `groupByRaw`, `having`, `havingRaw`

**Joins:** `join`, `innerJoin`, `leftJoin`, `rightJoin`

**Aggregates:** `sum`, `avg`, `min`, `max`, `increment`, `decrement`

**Terminal:** `find()`, `first()`, `count()`

On the backend, each method directly mutates a Knex query. On the frontend, each method records a serializable `QueryStep` sent to the server for execution.

## Adapter Pattern

The `ModelAdapter` interface decouples the Model from persistence:

```typescript
interface ModelAdapter {
  createStore(data): Record<string, any>;
  save(model, changes): Promise<void>;
  remove(model): Promise<void>;
  findById(modelClass, id): Promise<T | null>;
  query(modelClass): QueryChain<T>;
  patch(model, ops): Promise<void>;
}
```

| Adapter | Store | Persistence |
| --- | --- | --- |
| `FrontendAdapter` | Valtio proxy (reactive) | Transport RPC (Socket.IO / SSE) |
| `BackendAdapter` | Plain object | Knex + PostgreSQL |

Set the adapter once at startup:

```typescript
import { Model } from "@parcae/model";

Model.use(adapter);
```

## FrontendAdapter

Included in this package. Wraps a `Transport` to handle client-side persistence.

```typescript
import { FrontendAdapter } from "@parcae/model/adapters/client";

const adapter = new FrontendAdapter(transport);
Model.use(adapter);
```

The `Transport` interface is protocol-agnostic:

```typescript
interface Transport {
  get(path, data?): Promise<any>;
  post(path, data?): Promise<any>;
  put(path, data?): Promise<any>;
  patch(path, data?): Promise<any>;
  delete(path, data?): Promise<any>;
  subscribe?(event, handler): () => void;
  unsubscribe?(event, handler?): void;
  send?(event, ...args): void;
  readonly isConnected?: boolean;
  readonly isLoading?: boolean;
  on?(event, handler): void;
  off?(event, handler?): void;
  disconnect?(): void;
  reconnect?(): Promise<void>;
}
```

## Static Properties

| Property | Type | Description |
| --- | --- | --- |
| `type` | `string` | Model identifier. Used for table naming and routing. |
| `path` | `string?` | Custom API path. Defaults to `/v1/{type}s`. |
| `scope` | `ModelScope?` | Row-level security rules. |
| `indexes` | `IndexDefinition[]?` | Database index definitions. |
| `managed` | `boolean` | `false` for externally managed tables (e.g. auth). Default: `true`. |
| `__schema` | `SchemaDefinition?` | Resolved at startup by RTTIST. Maps properties to column types. |

## Type Mapping

| TypeScript | ColumnType | Postgres |
| --- | --- | --- |
| `string` | `"string"` | VARCHAR(2048) |
| `string` (long) | `"text"` | TEXT |
| `number` (int) | `"integer"` | INTEGER |
| `number` (float) | `"number"` | DOUBLE PRECISION |
| `boolean` | `"boolean"` | BOOLEAN |
| `Date` | `"datetime"` | TIMESTAMP |
| `SomeModel` | `{ kind: "ref" }` | VARCHAR (foreign key) |
| object / array | `"json"` | JSONB |

## Exports

```typescript
// Main
import { Model, generateId } from "@parcae/model";

// Frontend adapter
import { FrontendAdapter } from "@parcae/model/adapters/client";
import type { Transport } from "@parcae/model/adapters/client";

// Types
import type {
  ModelAdapter,
  ModelConstructor,
  ChangeSet,
  QueryChain,
  QueryStep,
  SchemaDefinition,
  ColumnType,
  PrimitiveColumnType,
  IndexDefinition,
  ModelScope,
  ScopeContext,
  ScopeResult,
  ScopeFunction,
  PatchOp,
} from "@parcae/model/adapters/types";
```

## License

MIT
