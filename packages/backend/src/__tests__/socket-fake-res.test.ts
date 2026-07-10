import { describe, expect, it, vi } from "vitest";
import { decompress } from "compress-json";
import pako from "pako";
import { createSocketFakeRes } from "../socket-fake-res";

function makeSocket() {
  return { emit: vi.fn() };
}

describe("createSocketFakeRes", () => {
  it("starts with writableEnded=false and statusCode=200", () => {
    const res = createSocketFakeRes(makeSocket(), "req-1");
    expect(res.writableEnded).toBe(false);
    expect(res.statusCode).toBe(200);
  });

  it("end() emits to the socket and flips writableEnded to true", () => {
    const socket = makeSocket();
    const res = createSocketFakeRes(socket, "req-1");
    res.end(JSON.stringify({ ok: true }));
    expect(res.writableEnded).toBe(true);
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith("req-1", expect.anything());
  });

  it("writeHead() sets statusCode before end()", () => {
    const res = createSocketFakeRes(makeSocket(), "req-1");
    res.writeHead(403, { "Content-Type": "application/json" });
    expect(res.statusCode).toBe(403);
    expect(res.writableEnded).toBe(false);
  });

  it("includes HTTP status in socket error envelopes", () => {
    const socket = makeSocket();
    const res = createSocketFakeRes(socket, "req-1");
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, error: "Not found" }));

    const frame = socket.emit.mock.calls[0]![1];
    const payload = decompress(
      JSON.parse(pako.ungzip(frame, { to: "string" })),
    );
    expect(payload).toMatchObject({
      success: false,
      error: "Not found",
      status: 404,
    });
  });

  // The load-bearing contract for the step-up gate: once a hook calls
  // `error(res, 403, …)` (which writeHead+end's the response), a route
  // handler that runs after the middleware short-circuit must NOT be
  // able to overwrite the response or emit a second frame.
  it("writeHead is idempotent: subsequent writeHead does not change statusCode after end", () => {
    const res = createSocketFakeRes(makeSocket(), "req-1");
    res.writeHead(403);
    res.end(JSON.stringify({ error: "MFA_REQUIRED" }));
    res.writeHead(200);
    expect(res.statusCode).toBe(403);
  });

  it("end is idempotent: subsequent end does not emit a second socket frame", () => {
    const socket = makeSocket();
    const res = createSocketFakeRes(socket, "req-1");
    res.writeHead(403);
    res.end(JSON.stringify({ error: "MFA_REQUIRED" }));
    res.end(JSON.stringify({ result: "leaked-data" }));
    expect(socket.emit).toHaveBeenCalledTimes(1);
  });

  it("simulates the gate-then-route sequence: only the gate's response reaches the socket", () => {
    const socket = makeSocket();
    const res = createSocketFakeRes(socket, "req-1");

    // Hook (step-up gate) writes 403.
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "MFA_REQUIRED" }));

    // Polka middleware: would check `if (res.writableEnded) return;`
    // and skip `next()`. The next assertion documents that contract
    // holding from the res's side.
    expect(res.writableEnded).toBe(true);

    // Even if a buggy/late route handler still runs, it can't override.
    res.writeHead(200);
    res.end(JSON.stringify({ result: { patient: "secret" } }));

    expect(res.statusCode).toBe(403);
    expect(socket.emit).toHaveBeenCalledTimes(1);
  });

  it("returns this from writeHead so chaining `.writeHead().end()` works", () => {
    const res = createSocketFakeRes(makeSocket(), "req-1");
    expect(res.writeHead(200)).toBe(res);
  });
});
