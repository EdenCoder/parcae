# Model Reference

Source: `packages/model/src/Model.ts` (~750 lines)

## Model Class

Extends `EventEmitter`. Constructor returns a **Proxy** that intercepts property access for change tracking, reference resolution, and raw ID access.

### Static Properties

```typescript
class Post extends Model {
  static type = "post" as const; // Model identifier, derives table name (pluralized)
  static path?: string; // Custom API path (default: /v1/{type}s)
  static scope?: ScopeDefinition; // Row-level security
  static indexes?: (string | string[])[];
  static searchFields?: string[]; // Fields for full-text search
  static managed: boolean = true; // false = skip DDL migration (externally managed tables)
  static __schema?: SchemaDefinition; // Resolved at startup by ts-morph
}
```

### Instance Properties

Instance data lives in `__data` (Valtio proxy on frontend, plain object on backend). Internal state uses Symbols to avoid collisions with data properties:

- `SYM_ADAPTER` -- ModelAdapter reference
- `SYM_UPDATES` -- Accumulated changes array
- `SYM_IS_NEW` -- True if not yet saved
- `SYM_INIT_DATA` -- Keys from constructor data (prevents defaults overwriting explicit values)

### Proxy Mechanics

The constructor Proxy intercepts:

- **`get`**: Returns data properties, handles `$property` for raw reference IDs, creates lazy-loading reference proxies for Model-typed properties
- **`set`**: Tracks changes in `SYM_UPDATES` array (only after construction completes via `queueMicrotask`)
- **`has`** / **`defineProperty`**: Standard forwarding

### Change Tracking

Every property set pushes to `SYM_UPDATES`. On `save()`, the adapter receives a `ChangeSet` containing all accumulated changes. After save, updates are cleared.

## Static Query API

All static methods build lazy chains via `lazyQuery()`. The adapter is resolved only when a terminal method is called:

```typescript
// Filtering
Post.where({ published: true });
Post.where("views", ">", 100);
Post.whereIn("status", ["draft", "review"]);
Post.whereNot({ archived: true });
Post.whereNotIn("role", ["banned"]);
Post.whereNull("deletedAt");
Post.whereNotNull("publishedAt");
Post.whereBetween("views", [10, 1000]);
Post.whereRaw("title ILIKE ?", ["%hello%"]);

// Chaining
Post.where({ published: true }).andWhere("views", ">", 10);
Post.where({ published: true }).orWhere({ featured: true });
Post.where({ published: true }).orWhereIn("id", ids);
Post.where({ published: true }).orWhereNull("category");

// Ordering and pagination
Post.orderBy("createdAt", "desc");
Post.orderByRaw("COALESCE(published_at, created_at) DESC");
Post.limit(25).offset(50);
Post.basic(25, "createdAt", "desc", 3); // limit, sort, direction, page

// Selection
Post.select("id", "title", "user");
Post.distinct("category");
Post.distinctOn("user");
Post.groupBy("category");
Post.having("count", ">", 5);

// Joins
Post.join("users", "posts.user", "users.id");
Post.leftJoin("comments", "posts.id", "comments.post_id");

// Aggregates
Post.where({ published: true }).count();
Post.sum("views");
Post.avg("rating");
Post.min("createdAt");
Post.max("views");
Post.increment("views", 1); // atomic increment
Post.decrement("stock", 1);

// Search
Post.search("hello world"); // hybrid full-text + fuzzy

// Terminals
const posts = await Post.where({ published: true }).find(); // array
const post = await Post.where({ slug: "hello" }).first(); // single or null
const count = await Post.where({ published: true }).count(); // number

// Direct lookup
const post = await Post.findById("abc123");

// Creation
const post = Post.create({ title: "New Post", user: userId });
```

## Instance Methods

```typescript
await post.save(); // Flush changes to backend (debounce-capable)
await post.save(true); // Immediate save, skip debounce
await post.remove(); // Delete
await post.refresh(); // Reload from backend, preserving pending changes
await post.patch([
  // RFC 6902 JSON Patch
  { op: "replace", path: "/title", value: "New Title" },
  { op: "add", path: "/tags/0", value: "new" },
  { op: "remove", path: "/draft" },
]);
post.toJSON(); // Plain object snapshot
await post.sanitize(user); // Override to strip sensitive fields for API response
```

### Save Behavior (Frontend)

When `save()` flushes, the FrontendAdapter chooses HTTP method by priority:

1. **Creating** (new record) -> `POST /path` with all data
2. **Ops** (patch ops accumulated) -> `PATCH /path/:id` with `{ ops }`
3. **Updates** (field changes via `set()`) -> `PUT /path/:id` with changed fields

## Reference Proxies

Properties typed as another Model return lazy-loading reference proxies:

```typescript
// post.user is a User reference
post.user.name; // Throws Promise (React Suspense) on first access
post.$user; // Returns raw ID string without loading
await post.user.name; // After loading, returns the actual name
```

References are cached globally in `Model.__refCache`.

## Schema Resolution

Source: `packages/backend/src/schema/resolver.ts`

Uses **ts-morph** (TypeScript Compiler API) to read actual TypeScript types from source files at startup. No decorators, no codegen, no transformers.

### Type Mapping

| TypeScript                 | Column Type               | Postgres              |
| -------------------------- | ------------------------- | --------------------- |
| `string`                   | `"string"`                | VARCHAR(2048)         |
| `string` (text annotation) | `"text"`                  | TEXT                  |
| `number` (integer)         | `"integer"`               | INTEGER               |
| `number` (float)           | `"number"`                | DOUBLE PRECISION      |
| `boolean`                  | `"boolean"`               | BOOLEAN               |
| `Date`                     | `"datetime"`              | TIMESTAMP             |
| `AnotherModel`             | `{ kind: "ref", target }` | VARCHAR (foreign key) |
| object / array             | `"json"`                  | JSONB                 |

### Caching

Schema resolution results are cached in `.parcae/schema.json` (gitignored). The cache is invalidated by SHA-256 hash of all model source files. Subsequent startups skip ts-morph if the hash matches.

## Adapter Interface

```typescript
interface ModelAdapter {
  createStore(data): Record<string, any>;
  save(model, changes: ChangeSet): Promise<void>;
  remove(model): Promise<void>;
  findById<T>(modelClass, id): Promise<T | null>;
  query<T>(modelClass): QueryChain<T>;
  queryFromClient?<T>(modelClass, scope, rawSteps): QueryChain<T>;
  patch(model, ops: PatchOp[]): Promise<void>;
}
```

The adapter is set globally via `Model.use(adapter)` and stored on `globalThis` so multiple copies of `@parcae/model` (common with pnpm) share the same state.

## FrontendAdapter

Source: `packages/model/src/adapters/client.ts`

- `createStore()` returns a Valtio proxy for reactive data
- `save()` sends changes over the transport (POST/PUT/PATCH)
- `query()` serializes chain as `QueryStep[]` and sends to server
- `findById()` sends `GET /path/:id`
- GET requests are deduplicated (in-flight coalescing)

### QueryStep Serialization

Frontend queries are serialized as arrays of `{ method, args }` objects and sent to the server. The BackendAdapter replays them against a Knex query builder with scope enforcement.

## GlobalThis Pattern

The adapter, client instances, and reference cache live on `globalThis` so they work correctly even when multiple copies of `@parcae/model` exist in the dependency tree (common in monorepos with pnpm).
