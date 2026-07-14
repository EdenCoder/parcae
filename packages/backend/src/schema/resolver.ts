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
 *   Ref<Model>        → { kind: "ref", target: Constructor }
 *   object/array/any  → "json"      (JSONB)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  Project,
  ClassDeclaration,
  Type,
  SyntaxKind,
  type Node,
  type TypeAliasDeclaration,
  type TypeNode,
  type TypeReferenceNode,
  type UnionTypeNode,
} from "ts-morph";
import type {
  SchemaDefinition,
  ColumnType,
  ModelConstructor,
} from "@parcae/model";

// ─── Properties to skip ──────────────────────────────────────────────────────

const BUILTIN_PROPERTIES = new Set(["id", "type", "createdAt", "updatedAt"]);

const SKIP_PREFIXES = ["__", "___"];
const PACKAGE_NAMES = new Map<string, string | null>();

function packageNameForSource(filePath: string): string | null {
  const cached = PACKAGE_NAMES.get(filePath);
  if (cached !== undefined) return cached;
  let directory = dirname(filePath);
  while (true) {
    const packagePath = join(directory, "package.json");
    if (existsSync(packagePath)) {
      try {
        // boundary: package.json is external JSON with an optional name.
        const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
          name?: unknown;
        };
        const name = typeof parsed.name === "string" ? parsed.name : null;
        PACKAGE_NAMES.set(filePath, name);
        return name;
      } catch {
        PACKAGE_NAMES.set(filePath, null);
        return null;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      PACKAGE_NAMES.set(filePath, null);
      return null;
    }
    directory = parent;
  }
}

function isParcaeRef(declarations: readonly Node[]): boolean {
  return declarations.some(
    (declaration) =>
      packageNameForSource(declaration.getSourceFile().getFilePath()) ===
      "@parcae/model",
  );
}

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

function refTargetFromNode(
  node: TypeNode,
  replacements: ReadonlyMap<string, Type>,
  seen: Set<string>,
): Type | null {
  if (node.getKind() === SyntaxKind.UnionType) {
    let target: Type | null = null;
    for (const member of (node as UnionTypeNode).getTypeNodes()) {
      if (member.getText() === "null" || member.getText() === "undefined") continue;
      const candidate = refTargetFromNode(member, replacements, seen);
      if (!candidate) return null;
      if (target && target.getText() !== candidate.getText()) return null;
      target = candidate;
    }
    return target;
  }
  if (node.getKind() !== SyntaxKind.TypeReference) return null;

  const reference = node as TypeReferenceNode;
  const name = reference.getTypeName().getText().split(".").pop();
  const symbol = reference.getTypeName().getSymbol();
  const alias = symbol?.getAliasedSymbol() ?? symbol;
  if (name === "Ref" && alias && isParcaeRef(alias.getDeclarations())) {
    const argument = reference.getTypeArguments()[0];
    if (!argument) return null;
    return replacements.get(argument.getText()) ?? argument.getType();
  }
  const arguments_ = reference.getTypeArguments().map(
    (argument) => replacements.get(argument.getText()) ?? argument.getType(),
  );
  for (const declaration of alias?.getDeclarations() ?? []) {
    if (declaration.getKind() !== SyntaxKind.TypeAliasDeclaration) continue;
    const key = `${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const aliasDeclaration = declaration as TypeAliasDeclaration;
    const aliasNode = aliasDeclaration.getTypeNode();
    if (!aliasNode) continue;
    const nestedReplacements = new Map<string, Type>();
    aliasDeclaration.getTypeParameters().forEach((parameter, index) => {
      const argument = arguments_[index];
      if (argument) nestedReplacements.set(parameter.getName(), argument);
    });
    const target = refTargetFromNode(aliasNode, nestedReplacements, seen);
    if (target) return target;
  }
  return refTarget(reference.getType(), seen, arguments_);
}

function refTarget(
  type: Type,
  seen = new Set<string>(),
  providedArguments?: readonly Type[],
): Type | null {
  const alias = type.getAliasSymbol();
  if (alias?.getName() === "Ref" && isParcaeRef(alias.getDeclarations())) {
    return type.getAliasTypeArguments()[0] ?? null;
  }

  if (!alias) return null;
  for (const declaration of alias.getDeclarations()) {
    if (declaration.getKind() !== SyntaxKind.TypeAliasDeclaration) continue;
    const key = `${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const aliasDeclaration = declaration as TypeAliasDeclaration;
    const node = aliasDeclaration.getTypeNode();
    if (!node) continue;
    const argumentsByName = new Map<string, Type>();
    const arguments_ = providedArguments ?? type.getAliasTypeArguments();
    aliasDeclaration.getTypeParameters().forEach((parameter, index) => {
      const argument = arguments_[index];
      if (argument) argumentsByName.set(parameter.getName(), argument);
    });
    const target = refTargetFromNode(node, argumentsByName, seen);
    if (target) return target;
  }
  return null;
}

function modelReference(type: Type): Extract<ColumnType, { kind: "ref" }> | null {
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  if (!symbol) return null;
  for (const declaration of symbol.getDeclarations()) {
    if (declaration.getKind() !== SyntaxKind.ClassDeclaration) continue;
    const classDeclaration = declaration as ClassDeclaration;
    if (!extendsModel(classDeclaration)) continue;
    return {
      kind: "ref",
      target: { type: classDeclaration.getName() ?? "" } as any,
    };
  }
  return null;
}

function resolveType(type: Type): ColumnType {
  const text = type.getText();
  const aliasName = type.getAliasSymbol()?.getName();

  // Ref<Model> expands to a runtime union that includes raw ids and plain
  // projected data. Resolve from its target type instead of treating that
  // implementation union as JSON. Follow one named alias as well so
  // `type UserRef = Ref<User>` keeps the same schema.
  const target = refTarget(type);
  if (target) {
    const reference = modelReference(target);
    if (!reference) {
      throw new Error(`Ref target "${target.getText()}" must be one concrete Model subclass`);
    }
    return reference;
  }

  // Unwrap union with null/undefined: `string | null` → string
  if (type.isUnion()) {
    const nonNullTypes = type
      .getUnionTypes()
      .filter((t) => !t.isNull() && !t.isUndefined());
    if (nonNullTypes.length === 1) {
      return resolveType(nonNullTypes[0]!);
    }
    const modelMember = nonNullTypes.find((member) => modelReference(member));
    if (modelMember) {
      throw new Error(
        `Model value "${modelMember.getText()}" must be declared through Ref<T>`,
      );
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
  // Alias-symbol check is the most reliable path: for imported type aliases
  // ts-morph's getText() returns the full module path, not just "Text".
  if (aliasName === "Text" || text === "Text" || text.includes('"Text"')) return "text";

  // Primitives
  if (type.isString() || type.isStringLiteral()) return "string";
  if (type.isNumber() || type.isNumberLiteral()) return "number";
  if (type.isBoolean() || type.isBooleanLiteral()) return "boolean";

  if (modelReference(type)) {
    throw new Error(`Model reference "${text}" must be declared with Ref<T>`);
  }

  // Date
  if (text === "Date" || text.includes("Date")) return "datetime";

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

      // Skip ambient (`declare`) properties — they describe values
      // installed at runtime (e.g. the `$field` raw-id companion of a
      // ref accessor), not persisted state. Treating one as a column
      // creates a real DB column whose NULL then clobbers the runtime
      // accessor on every hydrate.
      if (
        prop.isKind(SyntaxKind.PropertyDeclaration) &&
        prop.hasDeclareKeyword()
      )
        continue;

      // Same reasoning for `$`-prefixed names regardless of modifier:
      // the `$` namespace is reserved for parcae's runtime accessors
      // and must never round-trip into the schema.
      if (name.startsWith("$")) continue;

      // Get the declared type
      const type = prop.getType();
      try {
        schema[name] = resolveType(type);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${classDecl.getName() ?? "Model"}.${name}: ${message}`);
      }
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
