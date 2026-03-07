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
  const app = polka();
  app.use(bodyParser.json({ limit: "50mb" }));
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
