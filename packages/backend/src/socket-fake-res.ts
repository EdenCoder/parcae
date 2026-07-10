import pako from "pako";
import { compress } from "compress-json";

/**
 * Minimal Socket.IO target abstraction. Real `socket.io` `Socket`
 * instances implement this; tests can pass a mock with a `vi.fn()`.
 */
// biome-ignore lint/suspicious/noExplicitAny: socket.io Socket payload is unknown
export interface SocketEmitter {
  emit(event: string, payload: any): unknown;
}

/**
 * Construct the fake `res` object used to bridge Socket.IO RPC frames
 * through Polka's HTTP middleware chain.
 *
 * Polka middleware (and the `onAuthenticatedRequest` hook) inspects
 * `res.writableEnded` to decide whether to short-circuit. We mirror
 * that contract here so a step-up gate that calls `error(res, 403, …)`
 * actually halts dispatch instead of being silently overwritten by
 * the route handler that runs next. Both `writeHead` and `end` are
 * idempotent — a late write from a downstream handler can't clobber
 * the first response.
 *
 * Exported as a standalone factory so the contract is unit-testable
 * without spinning up a server.
 */
// biome-ignore lint/suspicious/noExplicitAny: returns a minimal Node res shape
export function createSocketFakeRes(
  socket: SocketEmitter,
  requestId: string,
): any {
  // biome-ignore lint/suspicious/noExplicitAny: parsed JSON of any shape
  let responseBody: any = null;
  return {
    statusCode: 200,
    writableEnded: false,
    // biome-ignore lint/suspicious/noExplicitAny: Node res shape
    writeHead(code: number, _headers?: any) {
      if (this.writableEnded) return this;
      this.statusCode = code;
      return this;
    },
    setHeader() {
      return this;
    },
    end(body?: string) {
      if (this.writableEnded) return;
      if (body) {
        try {
          responseBody = JSON.parse(body);
        } catch {
          responseBody = body;
        }
      }
      if (
        this.statusCode >= 400 &&
        responseBody &&
        typeof responseBody === "object" &&
        !Array.isArray(responseBody)
      ) {
        responseBody = { ...responseBody, status: this.statusCode };
      }
      const compressed = pako.gzip(
        JSON.stringify(compress(responseBody ?? { result: null, success: true })),
      );
      socket.emit(requestId, compressed);
      this.writableEnded = true;
    },
  };
}
