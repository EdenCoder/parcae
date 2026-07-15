/**
 * `parcae migrate:make <name>` — scaffold a new migration file.
 *
 * Generates `<migrations-dir>/<YYYYMMDDHHMMSS>-<slug>.ts` with a stub body.
 * Creates the migrations directory if missing.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { CommandResult } from "../output";
import { slugify, timestamp } from "../runtime";

export interface MakeResult {
  readonly path: string;
  readonly name: string;
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
  // Guard against typos or malicious --dir values resolving outside the cwd.
  // The explicit `--allow-outside-cwd` escape hatch exists for legitimate
  // cases (e.g. a monorepo where migrations live in a sibling package).
  const cwd = process.cwd();
  const rel = relative(cwd, dir);
  const outside =
    rel === "" ? false : rel.startsWith("..") || rel.startsWith("/");
  if (outside && flags["allow-outside-cwd"] !== true) {
    throw new Error(
      `[parcae] refusing to write outside cwd — resolved --dir to ${dir} ` +
        `(cwd: ${cwd}). Pass --allow-outside-cwd to override.`,
    );
  }
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
    // await db.raw(\`ALTER TABLE ... \`);
  },
);
`;
}
