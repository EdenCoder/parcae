/**
 * @parcae/backend — route()
 *
 * Express-compatible routing API. Middleware support.
 * These are the plain function APIs — Controllers are sugar on top.
 *
 * @example
 * ```typescript
 * import { route } from "@parcae/backend";
 *
 * route.post("/media/upload", (req, res) => {
 *   res.send({ url: "..." });
 * });
 *
 * route.post("/media/upload", requireAuth, rateLimit(100), (req, res) => {
 *   res.send({ url: "..." });
 * });
 *
 * route.get("/health", (req, res) => {
 *   res.json({ ok: true });
 * }, { priority: 0 });
 * ```
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type RouteHandler = (req: any, res: any, next?: () => void) => any;
export type Middleware = (req: any, res: any, next: () => void) => any;

export interface RouteOptions {
  /** Route priority (lower = higher priority). Default: 100. */
  priority?: number;
}

export interface RouteEntry {
  method: string;
  path: string;
  middlewares: Middleware[];
  handler: RouteHandler;
  priority: number;
}

// ─── Global Route Registry ───────────────────────────────────────────────────

const registeredRoutes: RouteEntry[] = [];

/**
 * Get all registered routes, sorted by priority.
 */
export function getRoutes(): RouteEntry[] {
  return [...registeredRoutes].sort((a, b) => a.priority - b.priority);
}

/**
 * Clear all registered routes (for testing).
 */
export function clearRoutes(): void {
  registeredRoutes.length = 0;
}

// ─── Route registration ─────────────────────────────────────────────────────

/**
 * Parse the flexible argument signature:
 *   route.post(path, handler)
 *   route.post(path, handler, options)
 *   route.post(path, middleware1, middleware2, ..., handler)
 *   route.post(path, middleware1, middleware2, ..., handler, options)
 */
function parseArgs(args: any[]): {
  middlewares: Middleware[];
  handler: RouteHandler;
  options: RouteOptions;
} {
  // Last arg could be options object
  let options: RouteOptions = {};
  let rest = args;

  if (
    rest.length > 0 &&
    typeof rest[rest.length - 1] === "object" &&
    rest[rest.length - 1] !== null &&
    !Array.isArray(rest[rest.length - 1]) &&
    typeof rest[rest.length - 1] !== "function"
  ) {
    options = rest[rest.length - 1] as RouteOptions;
    rest = rest.slice(0, -1);
  }

  // Last function is the handler, everything before it is middleware
  const handler = rest.pop() as RouteHandler;
  const middlewares = rest as Middleware[];

  return { middlewares, handler, options };
}

function registerRoute(method: string, path: string, ...args: any[]): void {
  const { middlewares, handler, options } = parseArgs(args);

  registeredRoutes.push({
    method: method.toUpperCase(),
    path,
    middlewares,
    handler,
    priority: options.priority ?? 100,
  });
}

// ─── Route API ───────────────────────────────────────────────────────────────

/**
 * Express-style route registration.
 *
 * ```typescript
 * route.get("/health", (req, res) => res.json({ ok: true }));
 * route.post("/upload", requireAuth, (req, res) => { ... });
 * route.post("/upload", requireAuth, (req, res) => { ... }, { priority: 50 });
 * ```
 */
export const route = {
  get(path: string, ...args: any[]) {
    registerRoute("GET", path, ...args);
  },
  post(path: string, ...args: any[]) {
    registerRoute("POST", path, ...args);
  },
  put(path: string, ...args: any[]) {
    registerRoute("PUT", path, ...args);
  },
  patch(path: string, ...args: any[]) {
    registerRoute("PATCH", path, ...args);
  },
  delete(path: string, ...args: any[]) {
    registerRoute("DELETE", path, ...args);
  },
  options(path: string, ...args: any[]) {
    registerRoute("OPTIONS", path, ...args);
  },
  head(path: string, ...args: any[]) {
    registerRoute("HEAD", path, ...args);
  },
  all(path: string, ...args: any[]) {
    registerRoute("ALL", path, ...args);
  },
};

// ─── Controller class (optional sugar) ───────────────────────────────────────

/**
 * Base Controller class. Optional class-based alternative to route().
 *
 * ```typescript
 * class MediaController extends Controller {
 *   @route.post("/media/upload")
 *   async upload(req, res) { ... }
 * }
 * ```
 *
 * The @route.* decorators internally call the same route.* functions.
 */
export class Controller {
  // Controllers are auto-discovered — the class just needs to exist.
  // Decorators on methods register routes at class load time.
}

export default route;
