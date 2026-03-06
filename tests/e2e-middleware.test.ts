/**
 * E2E with middleware — replicates the actual Parcae backend stack.
 * Tests that RPC calls work through body-parser + CORS + auth middleware.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "node:http";
import { parse as parseUrl } from "node:url";
import { PassThrough } from "node:stream";
import polka from "polka";
import bodyParser from "body-parser";
import { Server as SocketServer } from "socket.io";
import pako from "pako";
import { compress } from "compress-json";
import {
  SocketTransport,
  _resetSockets,
} from "../packages/sdk/src/transports/socket";

let httpServer: ReturnType<typeof createServer>;
let io: SocketServer;
let port: number;
let app: ReturnType<typeof polka>;

const TOKEN = "valid_token";
const USER_ID = "user_abc";

const ITEMS = [
  { id: "1", type: "post", title: "First" },
  { id: "2", type: "post", title: "Second" },
];

beforeAll(async () => {
  app = polka();

  // body-parser (same as Parcae)
  app.use(bodyParser.json({ limit: "50mb" }));
  app.use(bodyParser.urlencoded({ extended: true }));

  // Query string parsing (same as Parcae)
  app.use((req: any, _res: any, next: any) => {
    if (!req.query) {
      const parsed = parseUrl(req.url || "", true);
      req.query = parsed.query || {};
    }
    next();
  });

  // CORS middleware (same as Parcae)
  app.use((req: any, res: any, next: any) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  });

  // Auth middleware (same as Parcae — skip for socket RPC)
  app.use((req: any, _res: any, next: any) => {
    if (req._socketRpc) return next();
    req.session = null;
    next();
  });

  // Routes
  app.get("/v1/posts", (_req: any, res: any) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        result: { total: ITEMS.length, posts: ITEMS },
        success: true,
      }),
    );
  });

  app.get("/v1/posts/:id", (req: any, res: any) => {
    const item = ITEMS.find((i) => i.id === req.params.id);
    if (!item) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: item, success: true }));
  });

  httpServer = createServer(app.handler as any);
  io = new SocketServer(httpServer, { path: "/ws" });

  io.on("connection", (socket) => {
    let session: any = null;

    socket.on("authenticate", (token: string, cb: any) => {
      session = token === TOKEN ? { user: { id: USER_ID } } : null;
      cb({ userId: session?.user?.id ?? null });
    });

    socket.on(
      "call",
      (requestId: string, method: string, path: string, data: any) => {
        const [pathname, qs] = path.split("?");
        const query: Record<string, any> = {};
        if (qs) {
          for (const pair of qs.split("&")) {
            const [k, v] = pair.split("=");
            if (k)
              query[decodeURIComponent(k)] = v ? decodeURIComponent(v) : "";
          }
        }

        const fakeReq: any = Object.assign(new PassThrough(), {
          method: method.toUpperCase(),
          url: path,
          headers: { "content-type": "application/json" },
          body: data,
          query: method.toUpperCase() === "GET" ? { ...query, ...data } : query,
          params: {},
          session,
          _socketRpc: true,
        });

        const fakeRes: any = Object.assign(new PassThrough(), {
          statusCode: 200,
          writeHead(code: number) {
            this.statusCode = code;
            return this;
          },
          setHeader() {
            return this;
          },
          end(body?: string) {
            let responseBody: any = null;
            if (body) {
              try {
                responseBody = JSON.parse(body);
              } catch {
                responseBody = body;
              }
            }
            const compressed = pako.gzip(
              JSON.stringify(
                compress(responseBody ?? { result: null, success: true }),
              ),
            );
            socket.emit(requestId, compressed);
          },
        });

        (app as any).handler(fakeReq, fakeRes);
      },
    );
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      port = (httpServer.address() as any).port;
      resolve();
    });
  });
});

afterAll(async () => {
  io.close();
  await new Promise<void>((r) => httpServer.close(() => r()));
});

describe("E2E with middleware stack", () => {
  beforeEach(() => {
    _resetSockets();
    // Suppress unhandled rejections from socket cache cleanup
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", () => {});
  });

  it("should fetch list through body-parser + CORS + auth middleware", async () => {
    const transport = new SocketTransport({
      url: `http://localhost:${port}`,
      token: TOKEN,
    });
    await transport.auth.ready;

    const result = await transport.get("/posts");
    expect(result.total).toBe(2);
    expect(result.posts).toHaveLength(2);
    expect(result.posts[0].title).toBe("First");

    transport.disconnect();
  });

  it("should fetch single item with params", async () => {
    const transport = new SocketTransport({
      url: `http://localhost:${port}`,
      token: TOKEN,
    });
    await transport.auth.ready;

    const result = await transport.get("/posts/1");
    expect(result.id).toBe("1");
    expect(result.title).toBe("First");

    transport.disconnect();
  });

  it("should handle 404", async () => {
    const transport = new SocketTransport({
      url: `http://localhost:${port}`,
      token: TOKEN,
    });
    await transport.auth.ready;

    await expect(transport.get("/posts/999")).rejects.toThrow("Not found");

    transport.disconnect();
    await new Promise((r) => setTimeout(r, 50)); // let socket close cleanly
  });

  it("should work unauthenticated", async () => {
    const transport = new SocketTransport({
      url: `http://localhost:${port}`,
      token: null,
    });
    await transport.auth.ready;

    const result = await transport.get("/posts");
    expect(result.posts).toHaveLength(2);

    transport.disconnect();
  });
});
