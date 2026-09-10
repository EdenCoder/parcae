import { parse as parseUrl } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createServer_, listenServer, type ServerContext } from "../server";
import { shutdownResources } from "../shutdown";

vi.mock("node:url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:url")>();
  return { ...actual, parse: vi.fn(actual.parse) };
});

let server: ServerContext;
afterEach(async () => {
  await shutdownResources(server);
  vi.clearAllMocks();
});

function fixture() {
  server = createServer_({
    config: { TRUSTED_ORIGINS: "" } as any,
    version: "v1",
  });
  server.polka.get("/query", (req: any, res: any) => {
    res.end(JSON.stringify(req.query));
  });
  return server;
}

describe("HTTP query parsing", () => {
  it.each([
    ["", {}],
    ["?", {}],
    ["?tag=one&tag=two&empty=&flag", { tag: ["one", "two"], empty: "", flag: "" }],
    [
      "?name=Jane+Doe&literal=%2B&encoded%20key=%E2%9C%93",
      { name: "Jane Doe", literal: "+", "encoded key": "✓" },
    ],
  ])(
    "preserves Polka's query for /query%s without deprecated URL parsing",
    async (query, expected) => {
      fixture();
      await listenServer(server.httpServer, 0);
      const address = server.httpServer.address();
      if (!address || typeof address === "string") throw new Error("missing port");
      const response = await fetch(`http://127.0.0.1:${address.port}/query${query}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
      expect(parseUrl).not.toHaveBeenCalled();
    },
  );

  it("restores structured socket query data after Polka parses the URL", async () => {
    fixture();
    const structured = { query: [{ method: "where", args: [{ active: true }] }], limit: 5 };
    const req = {
      method: "GET",
      url: "/query?query=flattened&limit=99",
      headers: {},
      _socketQuery: structured,
      query: undefined as unknown,
    };
    const result = await new Promise<unknown>((resolve) => {
      const res = { end: (text: string) => resolve(JSON.parse(text)) };
      server.polka.handler(req as never, res as never);
    });
    expect(req.query).toBe(structured);
    expect(result).toEqual(structured);
    expect(parseUrl).not.toHaveBeenCalled();
  });
});
