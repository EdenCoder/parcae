/**
 * .parcae/ generation pipeline
 *
 * Runs RTTIST typegen at startup to generate type metadata, then uses
 * SchemaResolver to map types → column definitions. Like Next.js's .next/,
 * this is transparent to the developer.
 *
 * Flow:
 * 1. Ensure .parcae/ directory exists
 * 2. Hash source files to check if regeneration is needed
 * 3. Run @rttist/typegen to produce metadata.typelib
 * 4. Load metadata and resolve schemas
 * 5. Write resolved schemas to .parcae/schema.json (cache)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import type { ModelConstructor, SchemaDefinition } from "@parcae/model";
import { SchemaResolver, resolveFallbackSchema } from "./resolver";

// ─── Configuration ───────────────────────────────────────────────────────────

interface GenerateOptions {
  /** Root directory of the consumer's project. */
  projectRoot: string;
  /** Model source directories or file paths. */
  modelPaths: string[];
  /** Whether to force regeneration (ignore cache). */
  force?: boolean;
  /** Whether running in dev mode (enables watching). */
  dev?: boolean;
}

interface GenerateResult {
  /** Resolved schemas per model type. */
  schemas: Map<string, SchemaDefinition>;
  /** Whether typegen was actually run (false = cache hit). */
  regenerated: boolean;
}

// ─── File hashing ────────────────────────────────────────────────────────────

/**
 * Recursively collect all .ts files from a list of paths.
 */
function collectSourceFiles(paths: string[]): string[] {
  const files: string[] = [];

  for (const p of paths) {
    const resolved = resolve(p);
    if (!existsSync(resolved)) continue;

    const stat = statSync(resolved);
    if (stat.isFile() && resolved.endsWith(".ts")) {
      files.push(resolved);
    } else if (stat.isDirectory()) {
      const entries = readdirSync(resolved, { recursive: true });
      for (const entry of entries) {
        const entryPath = join(resolved, entry.toString());
        if (entryPath.endsWith(".ts") && !entryPath.includes("node_modules")) {
          files.push(entryPath);
        }
      }
    }
  }

  return files.sort();
}

/**
 * Compute a combined hash of all source files.
 */
function hashFiles(files: string[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    try {
      hash.update(readFileSync(file));
    } catch {
      // File may have been deleted
    }
  }
  return hash.digest("hex").slice(0, 16);
}

// ─── .parcae/ management ─────────────────────────────────────────────────────

/**
 * Ensure the .parcae/ directory exists and is gitignored.
 */
function ensureParcaeDir(projectRoot: string): string {
  const parcaeDir = join(projectRoot, ".parcae");
  if (!existsSync(parcaeDir)) {
    mkdirSync(parcaeDir, { recursive: true });
  }

  // Write a .gitignore inside .parcae/ for safety
  const gitignorePath = join(parcaeDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "*\n");
  }

  return parcaeDir;
}

/**
 * Check if the cache is still valid (source files haven't changed).
 */
function isCacheValid(parcaeDir: string, currentHash: string): boolean {
  const hashFile = join(parcaeDir, ".hash");
  if (!existsSync(hashFile)) return false;

  try {
    const cachedHash = readFileSync(hashFile, "utf-8").trim();
    return cachedHash === currentHash;
  } catch {
    return false;
  }
}

/**
 * Write the hash to the cache file.
 */
function writeCacheHash(parcaeDir: string, hash: string): void {
  writeFileSync(join(parcaeDir, ".hash"), hash);
}

// ─── RTTIST typegen runner ───────────────────────────────────────────────────

/**
 * Run RTTIST's typegen CLI to generate metadata.
 */
function runTypegen(projectRoot: string, parcaeDir: string): boolean {
  try {
    // Try to find the typegen binary
    const typegenBin = resolveTypegenBin(projectRoot);
    if (!typegenBin) {
      console.warn(
        "[parcae] @rttist/typegen not found. Using fallback schema resolution.",
      );
      return false;
    }

    console.log("[parcae] Generating type metadata...");

    execSync(`${typegenBin} generate --output "${parcaeDir}" --force`, {
      cwd: projectRoot,
      stdio: "pipe",
      timeout: 30_000,
    });

    console.log("[parcae] Type metadata generated.");
    return true;
  } catch (err) {
    console.warn(
      "[parcae] typegen failed, using fallback schema resolution.",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Find the @rttist/typegen binary path.
 */
function resolveTypegenBin(projectRoot: string): string | null {
  // Check node_modules/.bin/rttist
  const binPath = join(projectRoot, "node_modules", ".bin", "rttist");
  if (existsSync(binPath)) return binPath;

  // Check node_modules/.bin/typegen
  const typegenPath = join(projectRoot, "node_modules", ".bin", "typegen");
  if (existsSync(typegenPath)) return typegenPath;

  // Try npx resolution
  try {
    execSync("npx --no-install rttist --version", {
      cwd: projectRoot,
      stdio: "pipe",
      timeout: 5000,
    });
    return "npx --no-install rttist";
  } catch {
    return null;
  }
}

// ─── Main generation function ────────────────────────────────────────────────

/**
 * Generate type metadata and resolve schemas for the given models.
 *
 * This is called by createApp() at startup. It:
 * 1. Checks the .parcae/ cache
 * 2. Runs RTTIST typegen if needed
 * 3. Loads metadata and resolves schemas
 * 4. Falls back to default-value-based resolution if RTTIST unavailable
 */
export async function generateSchemas(
  models: ModelConstructor[],
  options: GenerateOptions,
): Promise<GenerateResult> {
  const { projectRoot, modelPaths, force = false } = options;

  // Ensure .parcae/ exists
  const parcaeDir = ensureParcaeDir(projectRoot);

  // Collect source files and hash them
  const sourceFiles = collectSourceFiles(modelPaths);
  const currentHash = hashFiles(sourceFiles);

  // Check cache
  let regenerated = false;
  if (force || !isCacheValid(parcaeDir, currentHash)) {
    // Run typegen
    const success = runTypegen(projectRoot, parcaeDir);
    regenerated = success;
    writeCacheHash(parcaeDir, currentHash);
  }

  // Try to load RTTIST metadata and resolve schemas
  const schemas = await resolveWithRttist(models, parcaeDir);

  if (schemas) {
    // Write resolved schemas to cache
    const schemaObj: Record<string, SchemaDefinition> = {};
    for (const [key, val] of schemas) {
      schemaObj[key] = val;
    }
    writeFileSync(
      join(parcaeDir, "schema.json"),
      JSON.stringify(schemaObj, null, 2),
    );

    return { schemas, regenerated };
  }

  // Fallback: resolve from default values
  console.log(
    "[parcae] Using fallback schema resolution (no RTTIST metadata).",
  );
  const fallbackSchemas = new Map<string, SchemaDefinition>();
  for (const ModelClass of models) {
    const schema = resolveFallbackSchema(ModelClass);
    fallbackSchemas.set(ModelClass.type, schema);
    (ModelClass as any).__schema = schema;
  }

  return { schemas: fallbackSchemas, regenerated: false };
}

/**
 * Try to resolve schemas using RTTIST metadata.
 * Returns null if RTTIST is not available or metadata doesn't exist.
 */
async function resolveWithRttist(
  models: ModelConstructor[],
  parcaeDir: string,
): Promise<Map<string, SchemaDefinition> | null> {
  try {
    // Try to load the generated metadata
    const metadataPath = join(parcaeDir, "metadata.typelib.js");
    if (!existsSync(metadataPath)) return null;

    // Dynamic import of the generated metadata
    const metadataModule = await import(metadataPath);
    const metadata = metadataModule.Metadata ?? metadataModule.default;
    if (!metadata?.getTypes) return null;

    // Resolve schemas
    const resolver = new SchemaResolver();
    const schemas = await resolver.resolve(models, metadata);
    resolver.resolveRefTargets(schemas, models);

    return schemas;
  } catch (err) {
    console.warn(
      "[parcae] Failed to load RTTIST metadata:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Try to load cached schemas from .parcae/schema.json.
 * Faster than full RTTIST resolution on subsequent starts.
 */
export function loadCachedSchemas(
  projectRoot: string,
): Record<string, SchemaDefinition> | null {
  try {
    const schemaPath = join(projectRoot, ".parcae", "schema.json");
    if (!existsSync(schemaPath)) return null;
    return JSON.parse(readFileSync(schemaPath, "utf-8"));
  } catch {
    return null;
  }
}
