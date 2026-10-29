import { describe, expect, it } from "vitest";
import { WRITE_RUNNING } from "@parcae/model";

import { PubSub } from "../services/pubsub";
import { createSocketFakeRes } from "../socket-fake-res";
import { createIdempotencyMiddleware } from "../services/idempotency";

const plain = () => {
  const frames: unknown[] = [];
  return { frames, socket: { emit: (_id: string, frame: unknown) => frames.push(frame), handshake: { query: { answers: "json" } } } };
};

const request = (key: string) => ({
  method  : "POST",
  path    : "/v1/lists",
  headers : { "idempotency-key": key },
  session : { user: { id: "user-1" } },
});

describe("idempotency middleware", () => {
  it("runs a key once, answers a repeat from memory, and refuses one while the first runs", async () => {
    const middleware = createIdempotencyMiddleware(new PubSub());
    let runs = 0;
    const first = plain();
    const firstRes = createSocketFakeRes(first.socket, "a");
    await middleware(request("k1"), firstRes, () => runs++);

    const running = plain();
    await middleware(request("k1"), createSocketFakeRes(running.socket, "b"), () => runs++);
    expect(running.frames[0]).toMatchObject({ success: false, code: WRITE_RUNNING, status: 409 });

    firstRes.writeHead(422);
    firstRes.end(JSON.stringify({ result: null, success: false, error: "No" }));
    await new Promise((settle) => setTimeout(settle, 0));

    const repeat = plain();
    await middleware(request("k1"), createSocketFakeRes(repeat.socket, "c"), () => runs++);
    expect(repeat.frames[0]).toEqual(first.frames[0]);
    expect(runs).toBe(1);
  });
});
