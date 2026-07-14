/**
 * @parcae/model
 *
 * The Parcae Model system — typed ORM base class with adapter pattern.
 * Class properties ARE the schema. Direct property access. Full type safety.
 */

export {
  dateSafeClone,
  ensureIntermediates,
  flushChangeEmits,
  generateId,
  isArrayIndexSegment,
  Model,
  serializeLazyQueryArgs,
  SYM_EXPANDED_REF,
  SYM_SERVER_MERGE,
  SYM_SERVER_PATCH,
  SYM_VERSION,
} from "./Model";
export type {
  ModelOperationSource,
  ModelOperationsEvent,
  ExpandedRef,
  Ref,
  WithRefs,
} from "./Model";

export { ops, dedupOps } from "./patch";
export type { OpBuilder } from "./patch";

/**
 * Branded type for unlimited TEXT columns (vs string which is VARCHAR 2048).
 * Use `content: Text = ""` on a Model property to get a TEXT column in Postgres.
 * At runtime it's just a string — the brand is erased.
 */
export type Text = string & { readonly __brand: "Text" };

export { FrontendAdapter } from "./adapters/client";
export { isNotFoundError } from "./adapters/client";
export type {
  Transport,
  TransportError,
  RequestOptions,
} from "./adapters/client";

export {
  CHAINABLE_METHODS,
  extractExpandFields,
  orderEmissionDisabled,
  stripExpandSteps,
} from "./adapters/types";
export type {
  ModelAdapter,
  ModelClass,
  ModelConstructor,
  QueryChain,
  QueryStep,
  SchemaDefinition,
  ColumnType,
  ScopeContext,
  PatchOp,
} from "./adapters/types";
