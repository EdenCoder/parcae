/**
 * SDK logger — same format as backend.
 * Only logs in development. Silent in production.
 */

const isDev =
  typeof process !== "undefined" ? process.env.NODE_ENV !== "production" : true;

function time(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export const log = {
  warn: (...args: any[]) =>
    isDev && console.warn(`%c${time()} SDK`, "color: #fb3", ...args),
  error: (...args: any[]) =>
    console.error(`%c${time()} SDK`, "color: #f44", ...args),
  debug: (...args: any[]) =>
    isDev && console.debug(`%c${time()} SDK`, "color: #888", ...args),
};
