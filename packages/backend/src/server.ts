/**
 * @parcae/backend — HTTP + WebSocket Server
 *
 * Polka (Express-compatible) for HTTP, Socket.IO for WebSocket.
 * Both share the same route registry via Trouter.
 */

import { createServer } from "node:http";
import { parse as parseUrl } from "node:url";
import polka from "polka";
import { Server as SocketServer } from "socket.io";
import bodyParser from "body-parser";
import type { Config } from "./config";
import { ClientError, error } from "./helpers";
import { log } from "./logger";

export interface ServerContext {
  polka: ReturnType<typeof polka>;
  io: SocketServer;
  httpServer: ReturnType<typeof createServer>;
}

export interface ServerOptions {
  config: Config;
  version: string;
}

/**
 * Create and configure the HTTP + WebSocket server.
 * Does NOT start listening — call server.listen() separately.
 */
export function createServer_(options: ServerOptions): ServerContext {
  const { config } = options;

  // Parse trusted origins
  const trustedOrigins = config.TRUSTED_ORIGINS
    ? config.TRUSTED_ORIGINS.split(",").map((o) => o.trim())
    : ["http://localhost:*", "https://localhost:*"];

  // Create Polka app with body parsing + query string parsing
  const app = polka({
    onError: (err: unknown, req: any, res: any) => {
      if (res.writableEnded || res.finished) return;
      const status = err instanceof ClientError ? err.status : 500;
      const message =
        err instanceof ClientError
          ? err.message
          : "An error occurred while processing your request";
      log.error("[http] request failed:", req.method, req.url, err);
      error(res, status, message);
    },
    onNoMatch: (req: any, res: any) => {
      log.warn("[http] no route:", req.method, req.url);
      error(res, 404, "Not found");
    },
  });
  app.use(
    bodyParser.json({
      limit: "50mb",
      // Stash the unparsed body so webhook handlers can verify HMAC
      // signatures (Stripe, GitHub, Svix, etc.) against the exact bytes the
      // sender signed. body-parser discards the raw stream once it parses,
      // and a re-serialised object is not byte-identical to the original, so
      // verification needs the buffer captured here.
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(bodyParser.urlencoded({ extended: true }));

  // Polka's handler unconditionally sets req.query = querystring.parse(info.query),
  // which flattens complex objects from socket RPC data. Restore the original
  // structured query for socket calls, and fall back to URL parsing for HTTP.
  app.use((req: any, _res: any, next: any) => {
    if (req._socketQuery) {
      req.query = req._socketQuery;
    } else if (!req.query || Object.keys(req.query).length === 0) {
      const parsed = parseUrl(req.url || "", true);
      req.query = parsed.query || {};
    }
    next();
  });

  // CORS middleware
  app.use((req: any, res: any, next: any) => {
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin, trustedOrigins)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    next();
  });

  // Create HTTP server from Polka's handler
  const httpServer = createServer(app.handler as any);

  // Create Socket.IO server
  const io = new SocketServer(httpServer, {
    path: "/ws",
    cors: {
      origin: (origin, callback) => {
        if (!origin || isOriginAllowed(origin, trustedOrigins)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
      credentials: true,
    },
    maxHttpBufferSize: 50e6, // 50 MB
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  return { polka: app, io, httpServer };
}

/** Start listening and reject startup on bind/runtime listen errors. */
export function listenServer(
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.off("error", handleError);
      server.off("listening", handleListening);
    };
    const handleError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const handleListening = () => {
      cleanup();
      resolve();
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    try {
      server.listen(port);
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

/**
 * Check if an origin matches any of the allowed patterns.
 * Supports wildcard matching (e.g. "http://localhost:*").
 */
function isOriginAllowed(origin: string, allowed: string[]): boolean {
  for (const pattern of allowed) {
    if (pattern === origin) return true;
    if (pattern.includes("*")) {
      const regex = new RegExp(
        "^" +
          pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
          "$",
      );
      if (regex.test(origin)) return true;
    }
  }
  return false;
}
