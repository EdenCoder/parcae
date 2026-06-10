/**
 * SchemaResolver — reads actual TypeScript types from model source files via ts-morph.
 *
 * No transformers, no build plugins, no runtime hacks. Reads your .ts files
 * directly using the TypeScript Compiler API and extracts property types.
 *
 * Type mapping:
 *   string            → "string"    (VARCHAR)
 *   number            → "number"    (DOUBLE PRECISION)
 *   boolean           → "boolean"   (BOOLEAN)
 *   Date              → "datetime"  (TIMESTAMP)
 *   Model subclass    → { kind: "ref", target: Constructor }
 *   object/array/any  → "json"      (JSONB)
 */

import { Project, ClassDeclaration, Type, SyntaxKind } from "ts-morph";
import type {
  SchemaDefinition,
  ColumnType,
  ModelConstructor,
} from "@parcae/model";

// ─── Properties to skip ──────────────────────────────────────────────────────

const BUILTIN_PROPERTIES = new Set(["id", "type", "createdAt", "updatedAt"]);

const SKIP_PREFIXES = ["__", "___"];

// ─── Type Resolution ─────────────────────────────────────────────────────────

/**
 * Treat `string & T` (and other intersections that contain `string`)
 * as a plain string for column-type purposes. The autocomplete-with-
 * fallback pattern `"x" | "y" | (string & {})` is the canonical TS
 * trick for "known values + open extension"; without this check, the
 * `& {}` member doesn't match `isString()` and the whole union falls
 * through to "json" — which then makes Postgres treat the column as
 * JSONB and choke on bare string values.
 */
function isStringLike(t: Type): boolean {
  if (t.isStringLiteral() || t.isString()) return true;
  if (t.isIntersection()) {
    const parts = t.getIntersectionTypes();
    if (parts.some((p) => p.isString() || p.isStringLiteral())) return true;
  }
  return false;
}

function isNumberLike(t: Type): boolean {
  if (t.isNumberLiteral() || t.isNumber()) return true;
  if (t.isIntersection()) {
    const parts = t.getIntersectionTypes();
    if (parts.some((p) => p.isNumber() || p.isNumberLiteral())) return true;
  }
  return false;
}

function isBooleanLike(t: Type): boolean {
  if (t.isBooleanLiteral() || t.isBoolean()) return true;
  if (t.isIntersection()) {
    const parts = t.getIntersectionTypes();
    if (parts.some((p) => p.isBoolean() || p.isBooleanLiteral())) return true;
  }
  return false;
}

function resolveType(type: Type): ColumnType {
  const text = type.getText();

  // Unwrap union with null/undefined: `string | null` → string
  if (type.isUnion()) {
    const nonNullTypes = type
      .getUnionTypes()
      .filter((t) => !t.isNull() && !t.isUndefined());
    if (nonNullTypes.length === 1) {
      return resolveType(nonNullTypes[0]!);
    }
    // Check if all members are the same primitive type
    // e.g. "active" | "pending" | "completed" → string
    // e.g. "x" | "y" | (string & {})           → string  (autocomplete-with-fallback)
    if (nonNullTypes.length > 1 && nonNullTypes.every(isStringLike)) {
      return "string";
    }
    if (nonNullTypes.length > 1 && nonNullTypes.every(isNumberLike)) {
      return "number";
    }
    if (nonNullTypes.length > 1 && nonNullTypes.every(isBooleanLike)) {
      return "boolean";
    }
    // Mixed-type union → json
    return "json";
  }

  // Text — branded string type for unlimited TEXT columns.
  // Matches `Text` (string & { __brand: "Text" }) from @parcae/model.
  // The `'"Text"'` check catches the branded intersection form that
  // ts-morph represents as `string & { readonly __brand: "Text" }`.
  if (text === "Text" || text.includes('"Text"')) return "text";

  // Primitives
  if (type.isString() || type.isStringLiteral()) return "string";
  if (type.isNumber() || type.isNumberLiteral()) return "number";
  if (type.isBoolean() || type.isBooleanLiteral()) return "boolean";

  // Date
  if (text === "Date" || text.includes("Date")) return "datetime";

  // Check if it's a class that extends Model
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  if (symbol) {
    const declarations = symbol.getDeclarations();
    for (const decl of declarations) {
      if (decl.getKind() === SyntaxKind.ClassDeclaration) {
        const classDecl = decl as ClassDeclaration;
        if (extendsModel(classDecl)) {
          return {
            kind: "ref",
            target: { type: classDecl.getName() ?? "" } as any,
          };
        }
      }
    }
  }

  // Array → json
  if (type.isArray()) return "json";

  // Object types (interfaces, type literals, Record<>, etc.) → json
  if (type.isObject()) return "json";

  // any → json
  if (type.isAny()) return "json";

  // Default → json (covers unknown types, intersections, etc.)
  return "json";
}

/**
 * Check if a class declaration extends Model (directly or transitively).
 */
function extendsModel(classDecl: ClassDeclaration): boolean {
  let current: ClassDeclaration | undefined = classDecl;
  while (current) {
    const baseClass = current.getBaseClass();
    if (!baseClass) return false;
    if (baseClass.getName() === "Model") return true;
    current = baseClass;
  }
  return false;
}

// ─── SchemaResolver ──────────────────────────────────────────────────────────

export class SchemaResolver {
  private project: Project;

  constructor(tsConfigFilePath?: string) {
    this.project = new Project({
      tsConfigFilePath,
      skipAddingFilesFromTsConfig: !tsConfigFilePath,
      compilerOptions: {
        strict: false,
        strictPropertyInitialization: false,
        noImplicitAny: false,
        skipLibCheck: true,
      },
    });
  }

  /**
   * Resolve schemas for model classes by reading their source files.
   *
   * @param models - Array of Model constructors (with static type)
   * @param sourceFiles - Paths to .ts files containing the model definitions
   */
  resolveFromFiles(
    models: ModelConstructor[],
    sourceFiles: string[],
  ): Map<string, SchemaDefinition> {
    // Add source files to the project
    for (const filePath of sourceFiles) {
      this.project.addSourceFileAtPath(filePath);
    }

    const schemas = new Map<string, SchemaDefinition>();
    const modelsByName = new Map(models.map((m) => [m.name, m]));

    // Find all class declarations that extend Model
    for (const sourceFile of this.project.getSourceFiles()) {
      for (const classDecl of sourceFile.getClasses()) {
        if (!extendsModel(classDecl)) continue;

        const className = classDecl.getName();
        if (!className) continue;

        const modelClass = modelsByName.get(className);
        if (!modelClass) continue;

        const schema = this.resolveClass(classDecl);
        schemas.set(modelClass.type, schema);

        // Inject onto the model constructor — `__schema` is on the
        // `ModelConstructor` interface as an optional field, no cast
        // needed.
        modelClass.__schema = schema;
      }
    }

    return schemas;
  }

  /**
   * Resolve a single class's instance properties into a SchemaDefinition.
   */
  private resolveClass(classDecl: ClassDeclaration): SchemaDefinition {
    const schema: SchemaDefinition = {};

    for (const prop of classDecl.getInstanceProperties()) {
      const name = prop.getName();

      // Skip builtins
      if (BUILTIN_PROPERTIES.has(name)) continue;

      // Skip private/internal
      if (SKIP_PREFIXES.some((p) => name.startsWith(p))) continue;

      // Skip methods
      if (prop.getKind() === SyntaxKind.MethodDeclaration) continue;

      // Get the declared type
      const type = prop.getType();
      schema[name] = resolveType(type);
    }

    return schema;
  }

  /**
   * Wire up ref targets to actual Model constructors.
   */
  resolveRefTargets(
    schemas: Map<string, SchemaDefinition>,
    models: ModelConstructor[],
  ): void {
    const modelsByName = new Map(models.map((m) => [m.name, m]));

    for (const [, schema] of schemas) {
      for (const [key, colDef] of Object.entries(schema)) {
        if (
          typeof colDef === "object" &&
          colDef !== null &&
          "kind" in colDef &&
          colDef.kind === "ref"
        ) {
          const targetName = colDef.target?.type;
          const targetModel = targetName
            ? modelsByName.get(targetName)
            : undefined;
          if (targetModel) {
            schema[key] = { kind: "ref", target: targetModel };
          } else {
            // Can't resolve ref — store as string (just the ID)
            schema[key] = "string";
          }
        }
      }
    }
  }
}
