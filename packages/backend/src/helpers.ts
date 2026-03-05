/**
 * @parcae/backend — Response helpers
 *
 * Common response utilities for route handlers.
 */

/**
 * Send a JSON response.
 *
 * @example
 * ```typescript
 * route.get("/health", (req, res) => {
 *   json(res, 200, { ok: true });
 * });
 * ```
 */
export function json(res: any, status: number, body: any): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Send a success response with the standard envelope.
 *
 * @example
 * ```typescript
 * route.get("/posts", (req, res) => {
 *   const posts = await Post.where({ published: true }).find();
 *   ok(res, { posts });
 * });
 * ```
 */
export function ok(res: any, result: any): void {
  json(res, 200, { result, success: true });
}

/**
 * Send an error response.
 *
 * @example
 * ```typescript
 * if (!userId) return error(res, 401, "Unauthorized");
 * ```
 */
export function error(res: any, status: number, message: string): void {
  json(res, status, { result: null, success: false, error: message });
}

/**
 * 401 Unauthorized shorthand.
 */
export function unauthorized(res: any): void {
  error(res, 401, "Unauthorized");
}

/**
 * 404 Not Found shorthand.
 */
export function notFound(res: any, what?: string): void {
  error(res, 404, what ? `${what} not found` : "Not found");
}

/**
 * 400 Bad Request shorthand.
 */
export function badRequest(res: any, message: string): void {
  error(res, 400, message);
}
