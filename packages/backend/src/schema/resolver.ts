/**
 * SchemaResolver — Maps RTTIST type metadata to Parcae column schemas.
 *
 * Reads property types from RTTIST's reflection API and produces
 * a SchemaDefinition (property name → column type) for each Model subclass.
 *
 * Type mapping:
 *   string         → "string"    (VARCHAR)
 *   number         → "number"    (DOUBLE PRECISION)
 *   boolean        → "boolean"   (BOOLEAN)
 *   Date           → "datetime"  (TIMESTAMP)
 *   Model subclass → { kind: "ref", target: Constructor }
 *   object/array   → "json"      (JSONB)
 *   optional        → adds nullable flag
 */

import type {
  SchemaDefinition,
  ColumnType,
  ModelConstructor,
} from "@parcae/model";

// ─── RTTIST type guards ──────────────────────────────────────────────────────
// We use dynamic imports + duck-typing to avoid hard dependency on rttist
// at the type level. The actual rttist package is loaded at runtime.

interface RttistType {
  isString(): boolean;
  isNumber(): boolean;
  isBoolean(): boolean;
  isClass(): boolean;
  isArray(): boolean;
  isObjectLiteral?(): boolean;
  isInterface?(): boolean;
  isUnion?(): boolean;
  displayName?: string;
  name?: string;
}

interface RttistClassType extends RttistType {
  isSubclassOf(other: RttistType): boolean;
  isDerivedFrom(other: RttistType): boolean;
  getCtor(): Promise<{ new (...args: any[]): any } | undefined>;
  extends?: RttistClassType;
}

interface RttistPropertyInfo {
  name: { name: string | symbol; isString(): boolean; isSymbol(): boolean };
  type: RttistType;
  optional: boolean;
}

interface RttistObjectLikeType extends RttistType {
  getProperties(): ReadonlyArray<RttistPropertyInfo>;
}

interface RttistMetadataLibrary {
  getTypes(): RttistType[];
}

// ─── Built-in properties to skip ─────────────────────────────────────────────

const BUILTIN_PROPERTIES = new Set(["id", "type", "createdAt", "updatedAt"]);

// ─── SchemaResolver ──────────────────────────────────────────────────────────

export class SchemaResolver {
  private modelBaseType: RttistType | null = null;
  private dateType: RttistType | null = null;

  /**
   * Resolve schemas for an array of Model constructors using RTTIST metadata.
   *
   * @param models - Array of Model constructor classes
   * @param metadata - The RTTIST MetadataLibrary instance
   * @returns Map of model type name → SchemaDefinition
   */
  async resolve(
    models: ModelConstructor[],
    metadata: RttistMetadataLibrary,
  ): Promise<Map<string, SchemaDefinition>> {
    const allTypes = metadata.getTypes();

    // Find the Model base type in the metadata
    this.modelBaseType =
      allTypes.find((t) => t.isClass() && (t as any).name === "Model") ?? null;

    // Find Date type
    this.dateType =
      allTypes.find((t) => t.isClass() && (t as any).name === "Date") ?? null;

    const schemas = new Map<string, SchemaDefinition>();

    for (const ModelClass of models) {
      // Find the RTTIST type matching this model class
      const rttistType = allTypes.find((t) => {
        if (!t.isClass()) return false;
        const ct = t as RttistClassType;
        // Match by name — the getCtor() approach is async, so we match by name
        return (t as any).name === ModelClass.name;
      }) as RttistObjectLikeType | undefined;

      if (!rttistType) {
        console.warn(
          `[parcae] Could not find RTTIST type for model "${ModelClass.name}". ` +
            `Falling back to empty schema.`,
        );
        schemas.set(ModelClass.type, {});
        continue;
      }

      const schema = this.resolveClass(rttistType);
      schemas.set(ModelClass.type, schema);

      // Inject the schema onto the model class
      (ModelClass as any).__schema = schema;
    }

    return schemas;
  }

  /**
   * Resolve a single class type's properties into a SchemaDefinition.
   */
  private resolveClass(classType: RttistObjectLikeType): SchemaDefinition {
    const schema: SchemaDefinition = {};
    const properties = classType.getProperties();

    for (const prop of properties) {
      // Skip symbols
      if (prop.name.isSymbol()) continue;

      const propName = prop.name.name as string;

      // Skip built-in Model properties
      if (BUILTIN_PROPERTIES.has(propName)) continue;

      // Skip private/internal properties (starting with __)
      if (propName.startsWith("__")) continue;

      const colType = this.resolveType(prop.type);
      schema[propName] = colType;
    }

    return schema;
  }

  /**
   * Map a RTTIST Type to a Parcae ColumnType.
   */
  private resolveType(type: RttistType): ColumnType {
    // String → VARCHAR
    if (type.isString()) return "string";

    // Number → DOUBLE PRECISION
    if (type.isNumber()) return "number";

    // Boolean → BOOLEAN
    if (type.isBoolean()) return "boolean";

    // Date → TIMESTAMP
    if (
      type.isClass() &&
      this.dateType &&
      (type as RttistClassType).isDerivedFrom(this.dateType)
    ) {
      return "datetime";
    }

    // Check for Date by name as fallback
    if (type.isClass() && (type as any).name === "Date") {
      return "datetime";
    }

    // Model subclass → Reference (VARCHAR storing ID)
    if (type.isClass() && this.modelBaseType) {
      const classType = type as RttistClassType;
      if (
        classType.isDerivedFrom(this.modelBaseType) ||
        classType.isSubclassOf(this.modelBaseType)
      ) {
        // We store the constructor reference for the lazy-loading proxy.
        // At this point we don't have the constructor, but we can
        // store the type info and resolve it later.
        return {
          kind: "ref",
          target: { type: (type as any).name } as any,
        };
      }
    }

    // Array → JSONB
    if (type.isArray()) return "json";

    // Object literal / Interface → JSONB
    if (type.isObjectLiteral?.()) return "json";
    if (type.isInterface?.()) return "json";

    // Union types → check if it's a nullable wrapper, otherwise JSONB
    if (type.isUnion?.()) {
      // TODO: Extract the non-null/undefined type and resolve that
      return "json";
    }

    // Default: JSONB for anything we don't recognize
    return "json";
  }

  /**
   * Resolve reference targets. After schema resolution, we need to wire up
   * ref targets to actual Model constructors (not just type names).
   */
  resolveRefTargets(
    schemas: Map<string, SchemaDefinition>,
    models: ModelConstructor[],
  ): void {
    const modelsByName = new Map<string, ModelConstructor>();
    for (const m of models) {
      modelsByName.set(m.name, m);
    }

    for (const [, schema] of schemas) {
      for (const [key, colDef] of Object.entries(schema)) {
        if (
          typeof colDef === "object" &&
          colDef !== null &&
          "kind" in colDef &&
          colDef.kind === "ref"
        ) {
          const targetName = (colDef.target as any)?.type;
          const targetModel = modelsByName.get(targetName);
          if (targetModel) {
            schema[key] = { kind: "ref", target: targetModel };
          } else {
            // If we can't resolve the ref, fall back to string (just stores the ID)
            console.warn(
              `[parcae] Could not resolve ref target "${targetName}" for property "${key}". ` +
                `Falling back to string column.`,
            );
            schema[key] = "string";
          }
        }
      }
    }
  }
}

/**
 * Resolve schemas without RTTIST — uses a simple default-value-based
 * heuristic for environments where RTTIST is not available.
 *
 * This is the fallback when typegen hasn't run or RTTIST isn't installed.
 */
export function resolveFallbackSchema(
  ModelClass: ModelConstructor,
): SchemaDefinition {
  const schema: SchemaDefinition = {};

  try {
    // Create a throwaway instance to inspect defaults
    const mockAdapter = {
      createStore: (data: Record<string, any>) => ({ ...data }),
      save: async () => {},
      remove: async () => {},
      findById: async () => null,
      query: () => ({}) as any,
      patch: async () => {},
    };

    const instance = new ModelClass(mockAdapter, {});
    const data = (instance as any).__data ?? instance;

    for (const [key, value] of Object.entries(data)) {
      if (BUILTIN_PROPERTIES.has(key)) continue;
      if (key.startsWith("__")) continue;

      if (typeof value === "string") schema[key] = "string";
      else if (typeof value === "number") schema[key] = "number";
      else if (typeof value === "boolean") schema[key] = "boolean";
      else if (value instanceof Date) schema[key] = "datetime";
      else if (Array.isArray(value)) schema[key] = "json";
      else if (typeof value === "object" && value !== null)
        schema[key] = "json";
      else schema[key] = "string"; // default fallback
    }
  } catch {
    // If instantiation fails, return empty schema
  }

  return schema;
}

export default SchemaResolver;
