/**
 * Regression test: the JSON body parser must accept RFC 6839 structured
 * suffixes, not just `application/json`.
 *
 * LiveKit posts webhooks as `application/webhook+json`. body-parser's default
 * type matches `application/json` exactly, so before this fix those requests
 * skipped the parser entirely: `req.body` arrived empty and `req.rawBody` was
 * never set, which made every HMAC check hash the empty string and fail
 * closed. The endpoint 401s on every legitimate delivery, and because it fails
 * closed rather than loudly, it looks like a signing-key problem.
 *
 * These tests drive the real exported options, so widening or narrowing them
 * in server.ts moves this test with it.
 */
import { Readable } from "node:stream";
import bodyParser from "body-parser";
import { describe, expect, it } from "vitest";
import { JSON_BODY_PARSER_OPTIONS } from "../server";

const parse = bodyParser.json(JSON_BODY_PARSER_OPTIONS);

/** Minimal IncomingMessage stand-in: a readable stream plus headers. */
function run(contentType: string, body: string): Promise<any> {
  const req = Readable.from([Buffer.from(body, "utf8")]) as any;
  req.method = "POST";
  req.headers = {
    "content-type": contentType,
    "content-length": String(Buffer.byteLength(body, "utf8")),
  };

  return new Promise((resolve, reject) => {
    parse(req, {} as never, (err?: unknown) =>
      err ? reject(err) : resolve(req),
    );
  });
}

describe("JSON body parser — webhook content types", () => {
  it("parses application/webhook+json and captures rawBody", async () => {
    const body = JSON.stringify({ event: "room_started", room: { name: "e1" } });

    const req = await run("application/webhook+json", body);

    expect(req.body).toEqual({ event: "room_started", room: { name: "e1" } });
    expect(Buffer.isBuffer(req.rawBody)).toBe(true);
  });

  it("captures rawBody byte-identically, which is what HMAC signs", async () => {
    // Key ordering and spacing survive only if the original bytes are kept.
    // A re-serialised object would normalise both and break verification.
    const body = '{"b":  2,\n  "a": 1}';

    const req = await run("application/webhook+json", body);

    expect(req.rawBody.toString("utf8")).toBe(body);
    expect(req.body).toEqual({ a: 1, b: 2 });
  });

  it("still parses plain application/json", async () => {
    const req = await run("application/json", '{"ok":true}');

    expect(req.body).toEqual({ ok: true });
    expect(req.rawBody.toString("utf8")).toBe('{"ok":true}');
  });

  it("accepts a charset parameter alongside the suffix", async () => {
    const req = await run(
      "application/webhook+json; charset=utf-8",
      '{"ok":true}',
    );

    expect(req.body).toEqual({ ok: true });
  });

  it("leaves non-JSON content types alone", async () => {
    // Proves the widening is scoped to the +json suffix rather than
    // swallowing every request body.
    const req = await run("text/plain", "not json at all");

    // body-parser returns early on a type miss without touching either field.
    expect(req.body).toBeUndefined();
    expect(req.rawBody).toBeUndefined();
  });
});
