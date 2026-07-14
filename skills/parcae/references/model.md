# Model Reference

Source: `packages/model/src/Model.ts`, `patch.ts`, `adapters/types.ts`, `adapters/client.ts`

## Model Class

Extends `EventEmitter` (eventemitter3). **The instance IS the data store** — there is no Proxy wrapper and no write interception. Plain field assignment (`post.title = "x"`) mutates the instance directly. It does NOT emit `"change"` and does NOT persist. Persistence and reactivity flow only through the three explicit write primitives below.

Reference fields are the one exception: `_apply()` installs getter/setter accessor pairs for them (see Reference Fields). Everything else is an ordinary own property.

> Never call `new Post(...)` directly — the constructor stages data but does not apply it (ES2022 subclass field initializers run after `super()` and would clobber it). Use `Post.create(data)` or `Post.hydrate(adapter, data)`; both run `_apply()` for you.

### Static Properties

```typescript
class Post extends Model {
  static type = "post"; // singular, lowercase discriminator (see below)
  static path?: string; // custom API path; default `/v1/${pluralize(type)}`
  static scope?: ModelScope; // { read?, create?, update?, delete?, patch? } row-level security
  static indexes?: (string | string[])[]; // single or composite indexes
  static searchFields?: string[]; // PLAIN-TEXT columns only (see gotcha)
  static managed: boolean = true; // false = skip DDL migration (externally managed tables)
  static readonly readonlyFields: readonly string[] = []; // stripped from POST/PUT/PATCH bodies
  static readonly privateFields: readonly string[] = []; // stripped by default sanitize()
  static __schema?: SchemaDefinition; // @internal, resolved at startup
}
```

`static type` derives, via `pluralize(type)`, all of:

- the table name (`pluralize("post")` → `posts`)
- the auto-CRUD path (`/v1/${pluralize(type)}`)
- the list-response collection key (`{ posts: [...] }`)

`pluralize` is irregular-aware: `category` → `categories`, `person` → `people`, and a type already ending in `s` is not double-pluralized. Both the backend and the SDK derive these the same way (`client.ts` uses `pluralize(modelClass.type)` for the path and the response key), so there is no client/backend split-brain. `type` is NOT stored as an instance field — read it from the static (`Post.type`) or `(post.constructor as typeof Model).type`. The framework re-injects a `type` key into `sanitize()` / `toJSON()` projections.

`readonlyFields` is layered on top of the always-protected system fields `id` / `createdAt` / `updatedAt` / `type`. Server-side code can still write readonly fields directly via `model.x = ...; await model.save()` — the restriction only applies to HTTP-driven entry points.

### Instance Properties

- `id: string`, `createdAt: Date | string`, `updatedAt: Date | string` — system fields, always set by `_apply()`.
- `tmp?: string` — client-side temporary ID for optimistic matching; stored in the JSONB overflow.
- `__savingCount: number` — in-flight save/patch count (0 = idle). Consumed by `useSaving`.
- `__isNew: boolean` — plain field, `true` for a fresh `create()`, `false` after `hydrate()` or a successful `save()`. Routes `flush()` → `save()`.
- `__data` — a computed **getter** (not a stored object), returning a plain snapshot filtered of methods, EventEmitter internals, `_`-prefixed fields, and `$field` ref accessors. Ref fields serialize to their raw id. (There is no Valtio store; `FrontendAdapter.createStore()` is unused.)

### Internal Symbols

Internal state uses Symbols so it never collides with data properties:

- `SYM_ADAPTER` — the `ModelAdapter` for this instance
- `SYM_PATCHING` — `Set<string>` of full RFC 6902 paths currently in-flight via `patch()`; server-merge and `useQuery` skip echoes for these sub-paths
- `SYM_SNAPSHOT` (`__serverSnapshot`) — last server-authoritative view of the document; `flush()` diffs against this
- `SYM_PENDING_DATA` — constructor data staged until subclass field initializers finish; consumed by `_apply()`
- `SYM_FLUSH_INFLIGHT` / `SYM_FLUSH_TRAILING` — concurrency control for `flush()` coalescing
- `SYM_SERVER_MERGE` (exported) — method symbol; atomically merges server-authoritative data
- `SYM_VERSION` (exported) — monotonic counter bumped on every `"change"` emit; backs `useModel` / `useModelAtomic` via `useSyncExternalStore`

## Write Primitives

There are exactly three ways to persist:

```typescript
await post.save();           // (1) full-document upsert
await post.patch(ops);       // (2) apply RFC 6902 ops locally + send them
await post.flush();          // (3) diff snapshot vs current, send the delta as a patch
```

### `save()`

Upsert the entire current document. No diffing, no dirty-tracking, no debounce — takes **no arguments** and is always immediate. Locally it stamps `updatedAt`, clears `__isNew`, and refreshes `__serverSnapshot` from the post-write state (so an immediately following `flush()` is a no-op). The adapter sends the full body; on create it adopts a server-returned `id`. Emits `"saving"` / `"saved"` (and `"__saving"`), but does NOT emit `"change"`.

### `patch(ops: PatchOp[])`

Apply a batch of RFC 6902 ops to the instance optimistically, then send them. Empty batches are a no-op. Ops are normalized via `dedupOps` (any op whose path lives under another `remove` in the same batch is dropped, plus duplicate identical removes). Missing intermediate objects/arrays are auto-vivified before `applyPatch`. Emits `"change"` **synchronously** (optimistic UI), bumps `SYM_VERSION`, records the op paths in `SYM_PATCHING` for the round-trip, then replays the ops onto `__serverSnapshot` so a later `flush()` won't re-emit them.

### `flush()`

The canonical "persist my edits" call. Diffs `__serverSnapshot` against the current `__data` (via `fast-json-patch.compare`) and sends the delta through `patch()` (which is what emits `"change"`). Routes to `save()` when `__isNew` (a PATCH to a nonexistent id would 404). No-op on an empty diff. Before diffing, both sides have `SYSTEM_DATA_KEYS` (`id`, `type`, `createdAt`, `updatedAt`, `tmp`) stripped and `Date` values coerced to ISO strings (otherwise `compare` emits ~24 char-level ops per Date field).

**Self-serializing:** concurrent `flush()` calls coalesce to at most two round-trips per burst — the first runs on the leading edge; all callers arriving while it is in flight share one "trailing" flush that captures changes made during the window. Streaming call sites can fire `flush()` per delta and `await Promise.all(...)` at the end without rolling their own debounce.

### Reactivity

`"change"` fires from exactly three sites: `patch()`, `flush()` (via its inner `patch()`), and `SYM_SERVER_MERGE`. **Plain field writes do not emit and do not re-render.** `patch()` / `flush()` emit synchronously; `SYM_SERVER_MERGE` emits via a microtask-batched queue (`scheduleChangeEmit`) so N per-row merges in one server frame coalesce into one commit per instance — critical for large `useQuery` list re-syncs. `flushChangeEmits()` (exported) force-drains the batched queue synchronously (tests, server coordinators).

## Dot-path Accessors

Both are **pure** — no I/O, no events, no persistence. Call `flush()` (or `patch([...])`) afterward to persist.

```typescript
const url = project.get<string>("blocks.abc.image.url"); // pure read; undefined if any segment missing
project.set("blocks.abc.image.url", "https://...");        // pure write; auto-vivifies intermediate objects
await project.flush();                                     // now persist
```

`set()` with a single-segment path is a plain top-level assignment; multi-segment paths walk and create missing intermediate objects (always objects, not arrays).

## Other Instance Methods

```typescript
await post.remove();                  // delete; emits "removed"
await post.refresh();                 // re-fetch via findById, merge via SYM_SERVER_MERGE
const safe = await post.sanitize(user); // projection safe to return from routes (honours privateFields)
const raw = post.toJSON();            // internal projection — IGNORES privateFields; do NOT return from routes
```

- `sanitize(user?)` — default projects every column except `static privateFields`, and injects `type`. The auto-CRUD GET routes call it on every row. Override for self-vs-other projections. `user` is passed but ignored by the default.
- `toJSON()` — same shape but does NOT honour `privateFields`; used internally (subscription deltas, hook payloads, snapshot source). Never expose directly to clients.

## Building Patch Ops

`patch()` accepts a raw `PatchOp[]`. The `ops` builder (exported from `@parcae/model`) avoids hand-writing op objects and can scope a batch under a shared path prefix:

```typescript
import { ops } from "@parcae/model";

await user.patch([
  ops.replace("/email", "new@example.com"),
  ops.remove("/pending/inviteToken"),
]);

// Scoped — every path under a shared base (leading slash is the caller's):
const block = ops.scope(`/blocks/${blockId}`);
await project.patch([
  block.remove("/portrait/url"),
  block.replace("/image/approved", true),
]);
```

`OpBuilder` methods: `add(path, value)`, `remove(path)`, `replace(path, value)`, `copy(from, path)`, `move(from, path)`, `test(path, value)`. `dedupOps(ops)` is also exported (runs automatically inside `patch()`; exposed for tests / pre-submission inspection).

## Query API

There are two layers. **Static entry points** live on the `Model` class and return either a terminal `Promise` or a `QueryChain`. **Chain methods** only exist on the returned `QueryChain` — they are NOT static.

### Static entry points

```typescript
Post.create(data?)                 // unsaved instance (marks __isNew)
Post.hydrate(adapter, data)        // server/DB hydration (not __isNew)
await Post.findById("abc123")      // single or null
await Post.count()                 // number (whole-table)
Post.where(...args)                // → QueryChain
Post.whereRaw(query, ...bindings)  // → QueryChain
Post.whereIn(col, values)          // → QueryChain
Post.whereNot(...args)             // → QueryChain
Post.whereNotIn(col, values)       // → QueryChain
Post.whereNull(col)                // → QueryChain
Post.whereNotNull(col)             // → QueryChain
Post.select(...columns)            // → QueryChain
Post.search(term)                  // → QueryChain (hybrid full-text + fuzzy)
```

These are the ONLY statics. `Post.orderBy(...)`, `Post.limit(...)`, `Post.sum(...)`, `Post.join(...)`, etc. **do not exist** as statics — start a chain first (e.g. `Post.where({}).orderBy(...)`).

> **Gotcha — `Model.where()` with zero args crashes.** TypeScript accepts it (`...args: any[]`), but it crashes at `.find()` with `The operator "undefined" is not permitted`. To start an unfiltered chain use the empty-object form `Post.where({})`, or a static like `Post.whereIn(col, ids)` / `Post.select(...)`.

### Chain methods (`QueryChain<T>`)

Available only after a static returns a chain. From `CHAINABLE_METHODS` and the `QueryChain` interface:

```typescript
// Filtering
.where(...) .andWhere(...) .orWhere(...)
.whereIn(col, vals) .whereNot(...) .whereNotIn(col, vals)
.whereNull(col) .whereNotNull(col) .whereBetween(col, [a, b])
.whereRaw(q, ...b) .orWhereRaw(q, ...b) .orWhereIn(col, vals) .orWhereNull(col) .whereExists(cb)

// Search
.search(term)

// Ordering & pagination
.orderBy(col, "asc" | "desc")  .orderBy(false)  // false → skip ORDER BY + suppress realtime `order` envelope
.orderByRaw(q, ...b)  .limit(n)  .offset(n)
// NOTE: .basic(...) is on the QueryChain TS interface but is NOT runtime-installed
// (absent from CHAINABLE_METHODS) — calling it type-checks but throws at runtime.

// Selection & grouping
.select(...cols) .distinct(...cols) .distinctOn(...cols)
.groupBy(...cols) .groupByRaw(q, ...b) .having(...) .havingRaw(q, ...b)

// Joins
.join(...) .innerJoin(...) .leftJoin(...) .rightJoin(...)

// Modifiers
.clearOrder() .clearSelect() .clearLimit() .from(table)

// Aggregates (chainable form)
.sum(col) .avg(col) .min(col) .max(col)
.increment(col, amount?) .decrement(col, amount?)

// Ref expansion (see below)
.expand(...fields)

// Terminals
await chain.find()   // Promise<T[]>
await chain.first()  // Promise<T | null>
await chain.count()  // Promise<number>
```

The list result array carries non-enumerable `__queryHash` and `__totalCount` properties attached by the frontend adapter.

> **Gotcha — `clearLimit()` is a client-query opt-out only.** It tells the backend to skip its default-25 injection. Calling it on a server-side `Model.where(...).find()` chain throws `knexQuery.clearLimit is not a function` — it is in `CHAINABLE_METHODS` so it type-checks, but the server dispatches `knexQuery[method](...)` and Knex has no `clearLimit`. Server queries have no default limit anyway; for a safety cap write `.limit(10_000)` explicitly.

### `expand()` — the N+1 fix

Without `.expand()`, ref columns stay raw id strings. `.expand("file")` inlines the full sanitized linked row; `.expand("file.url", "file.mime")` projects only `{ id, type, ...fields }`. Expanded values are plain partial data, not Model instances. v1 is one-hop only (dot-syntax is reserved for ref + field projection, not nested ref-chaining). Mixing a bare ref with dotted projections of the same ref promotes to whole-row. The raw id always lands in `$file` regardless. Backend validates each spec against `__schema` (unknown/non-ref → 400).

## Reference Fields

Declare model references with `Ref<T>`. `_apply()` keeps the value and its raw-id accessor synchronized without lazy loading or proxies:

```typescript
post.author       // raw id, assigned Model, expanded plain data, or null
post.author = u   // accepts a Model, a query expansion, an id string, or null
post.$author      // raw id string (no I/O); also settable
```

Reading a raw ref never performs I/O. Query with `.expand()` when linked data is needed, then narrow the `string | ExpandedRef<T>` value before reading projected fields. Sanitized wire rows include `$field`, so schema-free clients retain ref identity and serialize expanded values back to raw ids.

## Adapter Interface

```typescript
interface ModelAdapter {
  createStore(data): Record<string, any>;                 // backend builds DB rows; unused on frontend
  save(model): Promise<void>;                              // full-document upsert (no ChangeSet)
  remove(model): Promise<void>;
  findById<T>(modelClass, id): Promise<T | null>;
  query<T>(modelClass): QueryChain<T>;
  queryFromClient?<T>(modelClass, scope, rawSteps): QueryChain<T>; // backend only; scope-first replay
  patch(model, ops: PatchOp[]): Promise<void>;            // PATCH with RFC 6902 ops
}
```

There is no `ChangeSet` and no three-way HTTP-method priority. `Model.use(adapter)` binds the default adapter once and rejects attempts to replace it. `Model.bind(adapter)` returns a constructor proxy whose static operations use that adapter without mutating the source class, so multiple clients and server/client contexts stay independent. The SDK exposes this as `client.bind(ModelClass)`.

## FrontendAdapter

Source: `packages/model/src/adapters/client.ts`. Save is **2-way**:

- `save()` — `POST {full body}` when `__isNew` (adopting a server-echoed `id`), otherwise `PUT /path/:id {full body}`.
- `patch()` / `flush()` — `PATCH /path/:id { ops }` via the separate `patch()` adapter method.

`findById()` issues `GET /path/:id`. `query().find()` sends `{ __query: steps }` to `GET /path` and reads the list from `result[pluralize(type)]` (falling back to `result[type+"s"]` then `result.items`). `count()` sends `{ __query: steps, __count: true }`. Paths come from `modelClass.path ?? /v1/${pluralize(modelClass.type)}` with the `/v{n}` version prefix stripped (the transport re-adds it). Function args to where-callbacks are serialized as `{ __nested: steps }` recorders.

`createStore()` returns a shallow copy and is never called by the Model — frontend reactivity is purely EventEmitter (`model.on("change", ...)`), not Valtio.

## Query Chains Are Lazy

Static query methods build a `lazyQuery()` chain that records `{ method, args }` steps without an adapter. The adapter resolves only when a terminal (`find` / `first` / `count`) runs (`Model.hasAdapter()` ? `getAdapter()` : `await waitForAdapter()`), so queries can be constructed in React component bodies before `ParcaeProvider` mounts. The frontend adapter serializes the same steps as `QueryStep[]` and ships them to the server; the backend replays them against a scoped Knex builder.

## Schema Resolution

`__schema` is resolved at startup from TypeScript source types by a ts-morph-based resolver (`backend/src/schema/resolver.ts`; the schema layer is nicknamed "RTTIST" in `adapters/types.ts` comments). No decorators, no codegen at the model level.

### Type Mapping (`PrimitiveColumnType`)

| TypeScript                 | Column type | Postgres         |
| -------------------------- | ----------- | ---------------- |
| `string`                   | `"string"`  | VARCHAR(2048)    |
| `string` (text annotation) | `"text"`    | TEXT             |
| `number` (integer)         | `"integer"` | INTEGER          |
| `number` (float)           | `"number"`  | DOUBLE PRECISION |
| `boolean`                  | `"boolean"` | BOOLEAN          |
| `Date`                     | `"datetime"`| TIMESTAMP        |
| `AnotherModel`             | `{ kind: "ref", target }` | VARCHAR (foreign key id) |
| object / array             | `"json"`    | JSONB            |

> **Gotcha — inline union-literal alias resolves to JSONB.** Declare union-literal field types (`status: "a" | "b"`) in the SAME file as the model. Importing the alias from another workspace package can make the resolver treat it as opaque and fall back to JSONB instead of VARCHAR, producing `22P02 invalid input syntax for type json` in text-treating SQL. Keep a synced second definition rather than importing the type; verify with `information_schema.columns` (expect `character varying`).

### `searchFields`

When set, `ensureTable()` creates a generated `_search` tsvector column + GIN index, per-field trigram GIN indexes (pg_trgm), and on AlloyDB an `_embedding vector(768)` + ScaNN index. Fields are weighted by order (first = `A`, second = `B`, …). Query with `Project.search("...")`.

> **Gotcha — `searchFields` must be plain text columns only.** Listing a JSONB/array field (e.g. `string[]`) makes the generated `_search` tsvector DDL fail with `invalid input syntax for type json`, aborting that table's schema sync halfway. For array fields use `static indexes` + `.where(col, "@>", [...])`, or denormalize into a computed text column for search.

## Adapter Lifetime

The default adapter and its pending resolver are module-local. `Model.use()` resolves that default once and rejects replacement; `Model.bind(adapter)` captures independent adapters on constructor proxies.
