/**
 * End-to-end test: server + client + auth + query
 *
 * Boots a real Polka + Socket.IO server, connects a real Socket.IO client,
 * authenticates, and queries data. No mocks.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "node:http";
import polka from "polka";
import { Server as SocketServer } from "socket.io";
import pako from "pako";
import { compress } from "compress-json";
import { Model } from "@parcae/model";
import {
  SocketTransport,
  _resetSockets,
} from "../packages/sdk/src/transports/socket";

// ─── Test server ─────────────────────────────────────────────────────────────

let httpServer: ReturnType<typeof createServer>;
let io: SocketServer;
let port: number;

const TEST_USER_ID = "test_user_123";
const TEST_TOKEN = "test_token_abc";

const TEST_PROJECTS = [
  {
    id: "p1",
    type: "project",
    title: "Project One",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-02",
  },
  {
    id: "p2",
    type: "project",
    title: "Project Two",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-03",
  },
  {
    id: "p3",
    type: "project",
    title: "Project Three",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-04",
  },
];

beforeAll(async () => {
  const app = polka();

  // Register a test route
  app.get("/v1/projects", (_req: any, res: any) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        result: { total: TEST_PROJECTS.length, projects: TEST_PROJECTS },
        success: true,
      }),
    );
  });

  httpServer = createServer(app.handler as any);
  io = new SocketServer(httpServer, { path: "/ws" });

  // Socket.IO handler — same as Parcae backend
  io.on("connection", (socket) => {
    let session: any = null;

    socket.on("authenticate", (token: string, callback: any) => {
      if (token === TEST_TOKEN) {
        session = { userId: TEST_USER_ID };
        callback({ userId: TEST_USER_ID });
      } else {
        callback({ userId: null });
      }
    });

    socket.on(
      "call",
      (requestId: string, method: string, path: string, data: any) => {
        // Route through polka
        const { PassThrough } = require("node:stream");
        const fakeReq = Object.assign(new PassThrough(), {
          method: method.toUpperCase(),
          url: path,
          headers: { "content-type": "application/json" },
          body: data,
          query: method.toUpperCase() === "GET" ? data : {},
          params: {},
          session,
        });

        let responseBody: any = null;
        const fakeRes = Object.assign(new PassThrough(), {
          statusCode: 200,
          writeHead(code: number) {
            this.statusCode = code;
            return this;
          },
          setHeader() {
            return this;
          },
          end(body?: string) {
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

  // Start on random port
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("E2E: server + socket + auth + query", () => {
  beforeEach(() => _resetSockets());
  it("should connect to the server", async () => {
    const transport = new SocketTransport({
      url: `http://localhost:${port}`,
      token: null, // no auth
    });

    // Wait for connection
    await new Promise<void>((resolve) => {
      if (transport.isConnected) return resolve();
      transport.on("connected", () => resolve());
    });

    expect(transport.isConnected).toBe(true);
    expect(transport.auth.state.status).toBe("unauthenticated");

    transport.disconnect();
  });

  it("should authenticate with valid token", async () => {
    const transport = new SocketTransport({
      url: `http://localhost:${port}`,
      token: TEST_TOKEN,
    });

    // Wait for auth to resolve
    await transport.auth.ready;

    expect(transport.auth.state.status).toBe("authenticated");
    expect(transport.auth.state.userId).toBe(TEST_USER_ID);

    transport.disconnect();
  });

  it("should resolve unauthenticated with invalid token", async () => {
    const transport = new SocketTransport({
      url: `http://localhost:${port}`,
      token: "wrong_token",
    });

    await transport.auth.ready;

    expect(transport.auth.state.status).toBe("unauthenticated");
    expect(transport.auth.state.userId).toBeNull();

    transport.disconnect();
  });

  it("should make RPC calls via socket", async () => {
    const transport = new SocketTransport({
      url: `http://localhost:${port}`,
      token: TEST_TOKEN,
    });

    await transport.auth.ready;

    // This is the critical test — does transport.get() actually work?
    const result = await transport.get("/projects");

    expect(result).toBeDefined();
    expect(result.total).toBe(3);
    expect(result.projects).toHaveLength(3);
    expect(result.projects[0].title).toBe("Project One");

    transport.disconnect();
  });

  it("should block requests until auth resolves", async () => {
    const transport = new SocketTransport({
      url: `http://localhost:${port}`,
      token: undefined, // auth pending — will be set later
    });

    let resolved = false;

    // Start a request — it should block on auth.ready
    const req = transport.get("/projects").then((r) => {
      resolved = true;
      return r;
    });

    // Give it a moment — should NOT have resolved
    await new Promise((r) => setTimeout(r, 100));
    expect(resolved).toBe(false);

    // Now authenticate
    await transport.authenticate(TEST_TOKEN);

    // Request should now complete
    const result = await req;
    expect(resolved).toBe(true);
    expect(result.projects).toHaveLength(3);

    transport.disconnect();
  });

  it("should re-authenticate after token change", async () => {
    const transport = new SocketTransport({
      url: `http://localhost:${port}`,
      token: null, // start unauthenticated
    });

    await transport.auth.ready;
    expect(transport.auth.state.status).toBe("unauthenticated");

    // Now authenticate
    const result = await transport.authenticate(TEST_TOKEN);
    expect(result.userId).toBe(TEST_USER_ID);
    expect(transport.auth.state.status).toBe("authenticated");

    // Change to invalid token
    const result2 = await transport.authenticate("bad_token");
    expect(result2.userId).toBeNull();
    expect(transport.auth.state.status).toBe("unauthenticated");

    transport.disconnect();
  });
});
