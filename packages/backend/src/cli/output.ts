/**
 * @parcae/backend — CLI output formatting
 *
 * Every command returns a structured `CommandResult`; the dispatcher picks
 * between text (default) and JSON (--json) rendering. Commands never
 * `console.log` directly — their job is to return data; rendering is here.
 */

export interface CommandResult<T = unknown> {
  /** Human-readable text output (for default mode). Can be multi-line. */
  text: string;
  /** Structured payload for `--json` mode. */
  data: T;
  /** Non-zero exit code on failure. */
  exitCode?: number;
}

/**
 * Render a simple table. Returns a string — does not print. Columns are
 * widened to fit the longest cell in each column. Nullish cells render as
 * an em-dash so empty cells are visually distinct from missing data.
 */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  const cells = rows.map((r) => r.map((c) => stringify(c)));
  const widths = headers.map((h, i) => {
    let w = h.length;
    for (const row of cells) {
      const v = row[i] ?? "";
      if (v.length > w) w = v.length;
    }
    return w;
  });

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const line = (values: readonly string[]) =>
    values.map((v, i) => pad(v, widths[i]!)).join("  ");

  const sep = widths.map((w) => "─".repeat(w)).join("  ");
  const out: string[] = [line(headers), sep];
  for (const row of cells) out.push(line(row));
  return out.join("\n");
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(v);
}

/**
 * Render a numbered or bulleted list. Suitable for SQL statements from
 * `migrate:plan` or listings of drifted migrations.
 */
export function renderList(
  items: readonly string[],
  { numbered = false }: { numbered?: boolean } = {},
): string {
  return items
    .map((line, i) => {
      const prefix = numbered ? `${String(i + 1).padStart(2, " ")}. ` : "  • ";
      return prefix + line;
    })
    .join("\n");
}

/**
 * Print the result to stdout. JSON mode always emits valid JSON; text mode
 * prints the `text` field verbatim. Exit codes propagate via `process.exit`
 * when explicitly set.
 */
export function emit(
  result: CommandResult<unknown>,
  opts: { json: boolean },
): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(result.data, null, 2) + "\n");
  } else if (result.text) {
    process.stdout.write(result.text + "\n");
  }
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}
