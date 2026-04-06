/**
 * @parcae/model
 *
 * The Parcae Model system — typed ORM base class with adapter pattern.
 * Class properties ARE the schema. Direct property access. Full type safety.
 */

export { Model, generateId, SYM_SERVER_MERGE } from "./Model";
export type { WithRefs } from "./Model";

/**
 * Branded type for unlimited TEXT columns (vs string which is VARCHAR 2048).
 * Use `content: Text = ""` on a Model property to get a TEXT column in Postgres.
 * At runtime it's just a string — the brand is erased.
 */
export type Text = string & { readonly __brand: "Text" };

export { FrontendAdapter } from "./adapters/client";
export type { Transport, RequestOptions } from "./adapters/client";

export { CHAINABLE_METHODS } from "./adapters/types";
export type {
  ModelAdapter,
  ModelConstructor,
  ChangeSet,
  QueryChain,
  QueryStep,
  SchemaDefinition,
  ColumnType,
  ScopeContext,
  PatchOp,
} from "./adapters/types";
