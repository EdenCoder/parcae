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
 *
 * // Socket.IO event handlers:
 * route.on("chat:message", requireSocketAuth, async (ctx) => {
 *   ctx.emit("chat:chunk", { delta: "hello" });
 * });
 * ```
 */

// ─── HTTP Types ──────────────────────────────────────────────────────────────

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

// ─── Socket Types ────────────────────────────────────────────────────────────

/** Context passed to every route.on() handler. */
export interface SocketContext {
  /** The raw Socket.IO socket. */
  socket: any;
  /** The Socket.IO server instance (for targeted emits, rooms, etc.). */
  io: any;
  /** The event payload sent by the client. */
  data: any;
  /** Resolved auth session (same shape as req.session from HTTP routes). */
  session: any;
  /** Sugar for socket.id. */
  socketId: string;
  /** Emit an event back to this specific client. */
  emit: (event: string, ...args: any[]) => void;
}

export type SocketHandler = (ctx: SocketContext) => void | Promise<void>;
export type SocketMiddleware = (
  ctx: SocketContext,
  next: () => void | Promise<void>,
) => void | Promise<void>;

export interface SocketEntry {
  event: string;
  middlewares: SocketMiddleware[];
  handler: SocketHandler;
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

// ─── Global Socket Handler Registry ─────────────────────────────────────────

const registeredSocketHandlers: SocketEntry[] = [];

/**
 * Get all registered socket handlers.
 */
export function getSocketHandlers(): SocketEntry[] {
  return [...registeredSocketHandlers];
}

/**
 * Clear all registered socket handlers (for testing).
 */
export function clearSocketHandlers(): void {
  registeredSocketHandlers.length = 0;
}

/**
 * Run a socket middleware chain then the handler.
 * Middleware calls next() to proceed; throwing or not calling next() aborts.
 */
export async function runSocketChain(
  middlewares: SocketMiddleware[],
  handler: SocketHandler,
  ctx: SocketContext,
): Promise<void> {
  let idx = 0;

  const next = async (): Promise<void> => {
    if (idx < middlewares.length) {
      const mw = middlewares[idx++]!;
      await mw(ctx, next);
    } else {
      await handler(ctx);
    }
  };

  await next();
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
 *
 * // Socket.IO event handlers (registered once per connection):
 * route.on("chat:message", requireSocketAuth, async (ctx) => {
 *   ctx.emit("chat:chunk", { text: "..." });
 * });
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

  /**
   * Register a Socket.IO event handler.
   *
   * The handler is registered on every new socket connection.
   * Uses the same flexible argument signature as HTTP routes:
   *   route.on("event", handler)
   *   route.on("event", middleware1, middleware2, handler)
   */
  on(event: string, ...args: any[]) {
    // Last arg is always the handler; everything in between is middleware
    const handler = args.pop() as SocketHandler;
    const middlewares = args as SocketMiddleware[];

    registeredSocketHandlers.push({
      event,
      middlewares,
      handler,
    });
  },
};

// ─── Socket Auth Middleware ──────────────────────────────────────────────────

/**
 * Socket middleware that requires an authenticated session.
 * Equivalent to requireAuth for HTTP routes.
 */
export const requireSocketAuth: SocketMiddleware = (ctx, next) => {
  if (!ctx.session?.user?.id) {
    ctx.emit("error", { message: "Unauthorized" });
    return;
  }
  return next();
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
