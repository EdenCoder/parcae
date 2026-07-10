import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createServer_, listenServer } from "../server";
import { wrapHttpHandler } from "../routing/route";
import { shutdownResources } from "../shutdown";
import { log } from "../logger";

describe("listenServer", () => {
  it("rejects EADDRINUSE instead of leaving startup pending", async () => {
    const occupied = createServer();
    occupied.listen(0);
    await once(occupied, "listening");
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("missing port");

    const contender = createServer();
    await expect(listenServer(contender, address.port)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    await new Promise<void>((resolve, reject) => {
      occupied.close((err) => (err ? reject(err) : resolve()));
    });
  });
});

describe("async HTTP handlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes rejected promises to the JSON error responder", async () => {
    vi.spyOn(log, "error").mockImplementation(() => {});
    const server = createServer_({
      config: { TRUSTED_ORIGINS: "" } as any,
      version: "v1",
    });
    server.polka.get(
      "/reject",
      wrapHttpHandler(async () => {
        throw new Error("private detail");
      }),
    );
    await listenServer(server.httpServer, 0);
    const address = server.httpServer.address();
    if (!address || typeof address === "string") throw new Error("missing port");

    const response = await fetch(`http://127.0.0.1:${address.port}/reject`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      result: null,
      success: false,
      error: "An error occurred while processing your request",
    });
    await shutdownResources(server);
  });

  it("closes a server that never reached listen", async () => {
    const server = createServer_({
      config: { TRUSTED_ORIGINS: "" } as any,
      version: "v1",
    });
    await expect(shutdownResources(server)).resolves.toBeUndefined();
  });

  it("preserves explicit next() middleware semantics", async () => {
    const server = createServer_({
      config: { TRUSTED_ORIGINS: "" } as any,
      version: "v1",
    });
    server.polka.get(
      "/next",
      wrapHttpHandler(async (_req, _res, next) => {
        await Promise.resolve();
        return next?.();
      }),
      (_req: any, res: any) => res.end("continued"),
    );
    await listenServer(server.httpServer, 0);
    const address = server.httpServer.address();
    if (!address || typeof address === "string") throw new Error("missing port");

    const response = await fetch(`http://127.0.0.1:${address.port}/next`);
    expect(await response.text()).toBe("continued");
    await shutdownResources(server);
  });
});
