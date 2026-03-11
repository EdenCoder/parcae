import { log } from "../logger";
/**
 * Schema generation pipeline.
 *
 * 1. Hash model source files
 * 2. If hash matches .parcae/schema.json cache → load from cache
 * 3. Otherwise, run ts-morph to read actual TypeScript types
 * 4. Write results to .parcae/schema.json
 *
 * No transformers, no build plugins, no binaries, no fallbacks.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { readdirSync, statSync } from "node:fs";
import type { ModelConstructor, SchemaDefinition } from "@parcae/model";
import { SchemaResolver } from "./resolver";

// ─── Types ───────────────────────────────────────────────────────────────────

interface GenerateOptions {
  projectRoot: string;
  modelsPath?: string;
  force?: boolean;
  dev?: boolean;
}

interface GenerateResult {
  schemas: Map<string, SchemaDefinition>;
  cached: boolean;
}

// ─── File hashing ────────────────────────────────────────────────────────────

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  const entries = readdirSync(dir, { recursive: true });
  for (const entry of entries) {
    const entryPath = join(dir, entry.toString());
    if (
      entryPath.endsWith(".ts") &&
      !entryPath.endsWith(".d.ts") &&
      !entryPath.includes("node_modules")
    ) {
      try {
        if (statSync(entryPath).isFile()) files.push(entryPath);
      } catch {}
    }
  }
  return files.sort();
}

function hashFiles(files: string[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    try {
      hash.update(readFileSync(file));
    } catch {}
  }
  return hash.digest("hex").slice(0, 16);
}

// ─── .parcae/ management ─────────────────────────────────────────────────────

function ensureParcaeDir(projectRoot: string): string {
  const parcaeDir = join(projectRoot, ".parcae");
  if (!existsSync(parcaeDir)) mkdirSync(parcaeDir, { recursive: true });
  const gitignorePath = join(parcaeDir, ".gitignore");
  if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, "*\n");
  return parcaeDir;
}

// ─── Find models directory ───────────────────────────────────────────────────

function findModelsDir(
  projectRoot: string,
  modelsPath?: string,
): string | null {
  if (modelsPath) {
    const resolved = resolve(projectRoot, modelsPath);
    if (existsSync(resolved)) return resolved;
    return null;
  }

  const candidates = [
    join(projectRoot, "packages", "models", "src"),
    join(projectRoot, "..", "..", "packages", "models", "src"),
    join(projectRoot, "..", "models", "src"),
    join(projectRoot, "packages", "models"),
    join(projectRoot, "..", "..", "packages", "models"),
    join(projectRoot, "models"),
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  return null;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

interface CachedSchema {
  hash: string;
  schemas: Record<string, SchemaDefinition>;
}

function loadCache(parcaeDir: string): CachedSchema | null {
  try {
    const cachePath = join(parcaeDir, "schema.json");
    if (!existsSync(cachePath)) return null;
    return JSON.parse(readFileSync(cachePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeCache(
  parcaeDir: string,
  hash: string,
  schemas: Map<string, SchemaDefinition>,
): void {
  const obj: Record<string, SchemaDefinition> = {};
  for (const [key, val] of schemas) obj[key] = val;
  writeFileSync(
    join(parcaeDir, "schema.json"),
    JSON.stringify({ hash, schemas: obj }, null, 2),
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function generateSchemas(
  models: ModelConstructor[],
  options: GenerateOptions,
): Promise<GenerateResult> {
  const { projectRoot, modelsPath, force = false } = options;
  const parcaeDir = ensureParcaeDir(projectRoot);

  // Find models source directory
  const modelsDir = findModelsDir(projectRoot, modelsPath);
  if (!modelsDir) {
    log.warn("Models directory not found. No schemas resolved.");
    return { schemas: new Map(), cached: false };
  }

  // Collect and hash source files
  const sourceFiles = collectTsFiles(modelsDir);
  if (sourceFiles.length === 0) {
    log.warn("No .ts files found in models directory.");
    return { schemas: new Map(), cached: false };
  }

  const currentHash = hashFiles(sourceFiles);

  // Check cache
  if (!force) {
    const cache = loadCache(parcaeDir);
    if (cache && cache.hash === currentHash) {
      // Inject cached schemas onto model classes
      const schemas = new Map<string, SchemaDefinition>();
      for (const [type, schema] of Object.entries(cache.schemas)) {
        schemas.set(type, schema);
        const ModelClass = models.find((m) => m.type === type);
        if (ModelClass) (ModelClass as any).__schema = schema;
      }
      return { schemas, cached: true };
    }
  }

  // Resolve schemas from source using ts-morph
  log.info(`Resolving schemas from ${sourceFiles.length} source file(s)...`);

  // Find tsconfig.json near the models dir
  let tsConfigPath: string | undefined;
  let searchDir = modelsDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(searchDir, "tsconfig.json");
    if (existsSync(candidate)) {
      tsConfigPath = candidate;
      break;
    }
    const parent = dirname(searchDir);
    if (parent === searchDir) break;
    searchDir = parent;
  }

  const resolver = new SchemaResolver(tsConfigPath);
  const schemas = resolver.resolveFromFiles(models, sourceFiles);
  resolver.resolveRefTargets(schemas, models);

  // Cache
  writeCache(parcaeDir, currentHash, schemas);

  log.info(
    `Resolved schemas: ${[...schemas.entries()].map(([t, s]) => `${t}(${Object.keys(s).length})`).join(", ")}`,
  );

  return { schemas, cached: false };
}

export function loadCachedSchemas(
  projectRoot: string,
): Record<string, SchemaDefinition> | null {
  try {
    const cache = loadCache(join(projectRoot, ".parcae"));
    return cache?.schemas ?? null;
  } catch {
    return null;
  }
}
