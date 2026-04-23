/**
 * `parcae migrate:make <name>` — scaffold a new migration file.
 *
 * Generates `<migrations-dir>/<YYYYMMDDHHMMSS>-<slug>.ts` with a stub body.
 * Creates the migrations directory if missing.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandResult } from "../output";
import { slugify, timestamp } from "../runtime";

export interface MakeResult {
  path: string;
  name: string;
}

export async function run(
  positional: readonly string[],
  flags: Record<string, string | boolean>,
): Promise<CommandResult<MakeResult>> {
  const userName = positional[0];
  if (!userName) {
    throw new Error(
      "Usage: parcae migrate:make <name>\n\n" +
        "Example:\n" +
        "  parcae migrate:make rename-type-columns",
    );
  }

  const slug = slugify(userName);
  if (!slug) {
    throw new Error(
      `[parcae] name "${userName}" slugifies to empty — use alphanumeric characters.`,
    );
  }

  const dir = resolve(
    typeof flags.dir === "string" ? flags.dir : "./migrations",
  );
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const ts = timestamp();
  const name = `${ts}-${slug}`;
  const filePath = resolve(dir, `${name}.ts`);

  if (existsSync(filePath)) {
    throw new Error(`[parcae] file already exists: ${filePath}`);
  }

  writeFileSync(filePath, stub(name), "utf8");

  return {
    text:
      `Created ${filePath}\n\n` +
      `Next steps:\n` +
      `  1. Fill in the handler with your SQL\n` +
      `  2. Run \`parcae migrate:plan\` to preview\n` +
      `  3. Run \`parcae migrate:latest\` to apply`,
    data: { path: filePath, name },
  };
}

function stub(name: string): string {
  return `import { migration } from "@parcae/backend";

migration(
  "${name}",
  {
    // description: "",
    // ticket: "",
    // transaction: false,  // opt out for CREATE INDEX CONCURRENTLY, etc.
  },
  async ({ db, engine, log }) => {
    if (engine === "sqlite") {
      // SQLite-only or PG-only code paths — gate here.
    }
    // await db.raw(\`ALTER TABLE ... \`);
  },
);
`;
}
