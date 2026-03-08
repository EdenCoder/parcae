/**
 * @parcae/backend — Response helpers
 *
 * Common response utilities for route handlers.
 */

/**
 * An error that is safe to show to clients.
 *
 * Any code that wants to surface an error message to the end user should
 * throw a ClientError. All other errors are treated as internal and their
 * messages are never exposed — only logged server-side.
 */
export class ClientError extends Error {
  public status: number;

  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "ClientError";
    this.status = status;
  }
}

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
