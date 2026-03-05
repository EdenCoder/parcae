/**
 * @parcae/model
 *
 * The Parcae Model system — typed ORM base class with adapter pattern.
 * Class properties ARE the schema. Direct property access. Full type safety.
 */

export { Model, generateId } from "./Model";

export { FrontendAdapter } from "./adapters/client";
export type { Transport } from "./adapters/client";

export type {
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
} from "./adapters/types";
