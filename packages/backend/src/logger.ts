/**
 * @parcae/backend — Logger
 *
 * Simple, human-first logging.
 * Format: HH:MM:SS LEVEL message
 * Color in TTY, plain in pipes.
 */

// ─── Colors (only in TTY) ────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY ?? false;

const c = {
  dim: (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  blue: (s: string) => (isTTY ? `\x1b[34m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
};

// ─── Time ────────────────────────────────────────────────────────────────────

function time(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return c.dim(`${h}:${m}:${s}`);
}

// ─── Log functions ───────────────────────────────────────────────────────────

export function info(...args: any[]): void {
  console.log(`${time()} ${c.blue("INF")}`, ...args);
}

export function warn(...args: any[]): void {
  console.log(`${time()} ${c.yellow("WRN")}`, ...args);
}

export function error(...args: any[]): void {
  console.error(`${time()} ${c.red("ERR")}`, ...args);
}

export function success(...args: any[]): void {
  console.log(`${time()} ${c.green("OK ")}`, ...args);
}

export function debug(...args: any[]): void {
  if (process.env.NODE_ENV === "production") return;
  console.log(`${time()} ${c.dim("DBG")}`, ...args);
}

// ─── Logger object ───────────────────────────────────────────────────────────

export const log = { info, warn, error, success, debug };

export default log;
