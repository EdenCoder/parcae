/**
 * SDK logger — same format as backend.
 * Only logs in development. Silent in production.
 */

const isDev =
  typeof process !== "undefined" ? process.env.NODE_ENV !== "production" : true;

const isBrowser =
  typeof window !== "undefined" && typeof window.document !== "undefined";

function time(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function prefix(ansi: string): string[] {
  const tag = `${time()} SDK`;
  if (isBrowser) return [`%c${tag}`, `color: ${ansi}`];
  const codes: Record<string, string> = {
    "#fb3": "\x1b[33m",
    "#f44": "\x1b[31m",
    "#888": "\x1b[90m",
  };
  const code = codes[ansi] ?? "";
  return [`${code}${tag}\x1b[0m`];
}

export const log = {
  warn: (...args: any[]) =>
    isDev && console.warn(...prefix("#fb3"), ...args),
  error: (...args: any[]) =>
    console.error(...prefix("#f44"), ...args),
  debug: (...args: any[]) =>
    isDev && console.debug(...prefix("#888"), ...args),
};
