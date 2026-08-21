/**
 * Regression test: a request that fails inside body parsing must produce an
 * HTTP error response, not kill the process.
 *
 * Polka 0.5.2's default catch-all does `res.end(err.length && err || ...)`.
 * body-parser's errors ("request aborted", "request entity too large") carry
 * a numeric `length` property, so the Error object itself is written to the
 * response, `res.end` throws ERR_INVALID_ARG_TYPE, and on the abort path
 * the throw surfaces as an unhandled 'error' event on the IncomingMessage,
 * which exits the process. In production, webhook senders that hang up
 * mid-upload were killing the API on every retry.
 *
 * These tests boot the real server factory, so they pin the custom onError
 * handler that replaces Polka's default.
 */
import { connect } from "node:net";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../config";
import { createServer_, type ServerContext } from "../server";

let ctx: ServerContext;
let port: number;
const uncaught: unknown[] = [];
const onUncaught = (err: unknown) => {
  uncaught.push(err);
};

beforeAll(async () => {
  process.on("uncaughtException", onUncaught);
  ctx = createServer_({ config: {} as Config, version: "v1" });
  ctx.polka.post("/hook", (_req: any, res: any) => {
    res.statusCode = 200;
    res.end("ok");
  });
  await new Promise<void>((resolve) => ctx.httpServer.listen(0, resolve));
  port = (ctx.httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  process.off("uncaughtException", onUncaught);
  ctx.io.close();
  await new Promise((resolve) => ctx.httpServer.close(resolve));
});

function post(body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        port,
        method: "POST",
        path: "/hook",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("server survives body-parser errors", () => {
  it("stays alive when the client hangs up mid-body", async () => {
    // The production shape: a webhook sender times out and resets the
    // connection while the JSON body is still uploading.
    const socket = connect(port);
    await new Promise<void>((resolve) => socket.on("connect", resolve));
    socket.write(
      "POST /hook HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${port}\r\n` +
        "Content-Type: application/json\r\n" +
        "Content-Length: 1000\r\n" +
        "\r\n" +
        '{"partial":',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(uncaught).toEqual([]);
    const after = await post('{"ok":true}');
    expect(after.status).toBe(200);
  });
});
