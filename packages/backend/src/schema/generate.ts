/**
 * .parcae/ generation pipeline
 *
 * Runs RTTIST typegen to generate type metadata, then uses SchemaResolver
 * to map types → column definitions. Output goes to .parcae/ in the
 * consuming app (like Next.js's .next/).
 *
 * Flow:
 * 1. Ensure .parcae/ directory exists
 * 2. Find the models package (has reflect.config.json)
 * 3. Run rttist typegen against it
 * 4. Load the generated typelib
 * 5. Resolve schemas from metadata
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import type { ModelConstructor, SchemaDefinition } from "@parcae/model";
import { SchemaResolver, resolveFallbackSchema } from "./resolver";

// ─── Types ───────────────────────────────────────────────────────────────────

interface GenerateOptions {
  /** Root directory of the consuming app. */
  projectRoot: string;
  /** Path to the models package root (where reflect.config.json lives). */
  modelsPath?: string;
  /** Whether to force regeneration (ignore cache). */
  force?: boolean;
  /** Whether running in dev mode. */
  dev?: boolean;
}

interface GenerateResult {
  schemas: Map<string, SchemaDefinition>;
  regenerated: boolean;
}

// ─── .parcae/ management ─────────────────────────────────────────────────────

function ensureParcaeDir(projectRoot: string): string {
  const parcaeDir = join(projectRoot, ".parcae");
  if (!existsSync(parcaeDir)) {
    mkdirSync(parcaeDir, { recursive: true });
  }
  const gitignorePath = join(parcaeDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "*\n");
  }
  return parcaeDir;
}

// ─── Find rttist binary ─────────────────────────────────────────────────────

function resolveTypegenBin(searchDirs: string[]): string | null {
  for (const dir of searchDirs) {
    // Direct node_modules/.bin
    const binPath = join(dir, "node_modules", ".bin", "rttist");
    if (existsSync(binPath)) return binPath;

    // pnpm nested path
    const pnpmBin = join(
      dir,
      "node_modules",
      ".pnpm",
      "node_modules",
      ".bin",
      "rttist",
    );
    if (existsSync(pnpmBin)) return pnpmBin;
  }

  // Walk up from first search dir to find monorepo root
  let current = searchDirs[0];
  if (current) {
    for (let i = 0; i < 10; i++) {
      const binPath = join(current, "node_modules", ".bin", "rttist");
      if (existsSync(binPath)) return binPath;
      const pnpmBin = join(
        current,
        "node_modules",
        ".pnpm",
        "node_modules",
        ".bin",
        "rttist",
      );
      if (existsSync(pnpmBin)) return pnpmBin;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return null;
}

// ─── Find models package ─────────────────────────────────────────────────────

/**
 * Find the models package directory. Looks for reflect.config.json
 * in common locations relative to the project root.
 */
function findModelsDir(
  projectRoot: string,
  modelsPath?: string,
): string | null {
  if (modelsPath) {
    const resolved = resolve(projectRoot, modelsPath);
    if (existsSync(join(resolved, "reflect.config.json"))) return resolved;
    return null;
  }

  // Common locations in a monorepo
  const candidates = [
    join(projectRoot, "packages", "models"),
    join(projectRoot, "..", "..", "packages", "models"), // from apps/api/
    join(projectRoot, "..", "models"),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "reflect.config.json"))) return candidate;
  }

  return null;
}

// ─── Run typegen ─────────────────────────────────────────────────────────────

function runTypegen(
  modelsDir: string,
  parcaeDir: string,
  projectRoot: string,
): boolean {
  const typegenBin = resolveTypegenBin([projectRoot, modelsDir]);
  if (!typegenBin) {
    console.warn("[parcae] rttist binary not found. Skipping type generation.");
    return false;
  }

  try {
    console.log(`[parcae] Running typegen against ${modelsDir}...`);

    // rttist generate runs from the models package dir where reflect.config.json is.
    // It reads outDir from the config. We temporarily override it to point to .parcae/.
    // Since rttist doesn't support --output flag, we need to update the config or
    // run from a temp config. Simplest: run from modelsDir with default outDir,
    // then copy the output.
    execSync(`${typegenBin} generate --force`, {
      cwd: modelsDir,
      stdio: "pipe",
      timeout: 60_000,
    });

    // Find the output — rttist puts it in the outDir from reflect.config.json
    // or the default "dist/" location
    const possibleOutputs = [
      join(modelsDir, ".rttist"),
      join(modelsDir, "dist"),
    ];

    for (const outputDir of possibleOutputs) {
      const publicTypelib = join(outputDir, "public.typelib.js");
      const internalTypelib = join(outputDir, "internal.typelib.js");
      const typelib = existsSync(publicTypelib)
        ? publicTypelib
        : existsSync(internalTypelib)
          ? internalTypelib
          : null;

      if (typelib) {
        // Copy to .parcae/
        const content = readFileSync(typelib, "utf-8");
        writeFileSync(join(parcaeDir, "metadata.typelib.js"), content);
        console.log("[parcae] Type metadata generated.");

        // Clean up the output from models dir
        try {
          const files = readdirSync(outputDir);
          for (const f of files) {
            const { unlinkSync } = require("node:fs");
            unlinkSync(join(outputDir, f));
          }
          const { rmdirSync } = require("node:fs");
          rmdirSync(outputDir);
        } catch {}

        // Also clean .metadata cache dir
        try {
          const metadataDir = join(modelsDir, ".metadata");
          if (existsSync(metadataDir)) {
            execSync(`rm -rf "${metadataDir}"`, { stdio: "pipe" });
          }
        } catch {}

        return true;
      }
    }

    console.warn("[parcae] typegen ran but no output found.");
    return false;
  } catch (err) {
    console.warn(
      "[parcae] typegen failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

// ─── Load metadata ───────────────────────────────────────────────────────────

async function loadTypelibMetadata(parcaeDir: string): Promise<any | null> {
  const typelibPath = join(parcaeDir, "metadata.typelib.js");
  if (!existsSync(typelibPath)) return null;

  try {
    const mod = await import(typelibPath);
    return mod.Metadata ?? mod.default ?? null;
  } catch (err) {
    console.warn(
      "[parcae] Failed to load typelib:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function generateSchemas(
  models: ModelConstructor[],
  options: GenerateOptions,
): Promise<GenerateResult> {
  const { projectRoot, modelsPath, force = false } = options;
  const parcaeDir = ensureParcaeDir(projectRoot);

  // Try to find models package and run typegen
  const modelsDir = findModelsDir(projectRoot, modelsPath);
  let regenerated = false;

  if (modelsDir) {
    const typelibExists = existsSync(join(parcaeDir, "metadata.typelib.js"));
    if (force || !typelibExists) {
      regenerated = runTypegen(modelsDir, parcaeDir, projectRoot);
    }
  }

  // Try to load RTTIST metadata
  const metadata = await loadTypelibMetadata(parcaeDir);
  if (metadata) {
    try {
      const resolver = new SchemaResolver();
      const schemas = await resolver.resolve(models, metadata);
      resolver.resolveRefTargets(schemas, models);

      // Inject schemas onto model classes
      for (const [type, schema] of schemas) {
        const ModelClass = models.find((m) => m.type === type);
        if (ModelClass) (ModelClass as any).__schema = schema;
      }

      return { schemas, regenerated };
    } catch (err) {
      console.warn(
        "[parcae] RTTIST schema resolution failed, using fallback:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Fallback
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
