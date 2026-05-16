/**
 * SocketTransport — in-flight request behaviour across disconnect/reconnect.
 *
 * Complements `socket-transport.test.ts` (which covers connect /
 * disconnect events + listener-lifecycle). This file pushes on the
 * request layer:
 *
 *   - GET requests are deduped while in-flight (same path + body)
 *   - A request issued while disconnected awaits the next connect
 *     before firing
 *   - A request in flight across a server-side timeout rejects with
 *     a clear `RPC timeout` error and clears its dedup slot
 *   - The dedup Map clears on resolve, reject, AND timeout, so a
 *     retry after a failure can succeed
 *   - A request started while auth is pending awaits `auth.ready`
 *     before issuing — and re-awaits if auth resets mid-flight
 *
 * Uses the same FakeSocket harness as the existing transport tests.
 * No real network, no React.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ─── socket.io-client mock ──────────────────────────────────────────────────

/**
 * Minimal Socket.IO-shaped EventEmitter. Mirrors the surface
 * `SocketTransport` uses. Tests drive lifecycle events through
 * `_fire("event", ...args)`.
 */
class FakeSocket {
  connected = false;
  private handlers = new Map<string, Set<(...args: any[]) => void>>();
  public emits: { event: string; args: any[] }[] = [];

  on(event: string, handler: (...args: any[]) => void): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return this;
  }

  once(event: string, handler: (...args: any[]) => void): this {
    const wrapped = (...args: any[]) => {
      this.off(event, wrapped);
      handler(...args);
    };
    (wrapped as any).__original = handler;
    this.on(event, wrapped);
    return this;
  }

  off(event: string, handler?: (...args: any[]) => void): this {
    const set = this.handlers.get(event);
    if (!set) return this;
    if (!handler) {
      set.clear();
      return this;
    }
    for (const h of set) {
      if (h === handler || (h as any).__original === handler) set.delete(h);
    }
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    this.emits.push({ event, args });
    return true;
  }

  _fire(event: string, ...args: any[]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of [...set]) h(...args);
  }

  connect(): void {
    this.connected = true;
    this._fire("connect");
  }

  disconnect(): void {
    this.connected = false;
    this._fire("disconnect");
  }
}

let currentSocket: FakeSocket;

vi.mock("socket.io-client", () => ({
  default: vi.fn(() => {
    currentSocket = new FakeSocket();
    return currentSocket;
  }),
}));

// eslint-disable-next-line import/first
import { SocketTransport, _resetSockets } from "../transports/socket";
// eslint-disable-next-line import/first
import pako from "pako";
// eslint-disable-next-line import/first
import { compress } from "compress-json";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTransport(token: string | null | undefined = null) {
  _resetSockets();
  return new SocketTransport({ url: "http://localhost:0", token });
}

/**
 * Server-side fake — reply to the most recent `call` emit by firing
 * the request id back with a gzipped JSON envelope. Matches the wire
 * format the real backend uses (see `socket-fake-res.ts`).
 */
function respondTo(call: { event: string; args: any[] }, body: any): void {
  const requestId = call.args[0] as string;
  const compressed = pako.gzip(JSON.stringify(compress(body)));
  currentSocket._fire(requestId, compressed);
}

/** Extract the most recent emit by event name. */
function lastEmit(event: string): { event: string; args: any[] } | undefined {
  return [...currentSocket.emits].reverse().find((e) => e.event === event);
}

/** All emits matching an event name. */
function allEmits(event: string): { event: string; args: any[] }[] {
  return currentSocket.emits.filter((e) => e.event === event);
}

/** Authenticate the transport so requests can proceed. */
function completeAuth(userId: string | null = "u1"): void {
  const auth = lastEmit("authenticate");
  if (!auth) throw new Error("no authenticate emit found");
  const cb = auth.args[1] as (resp: { userId: string | null }) => void;
  cb({ userId });
}

/**
 * Yield to the microtask queue so an `await` waiting on a promise
 * we just resolved synchronously gets to run. `fetch` chains through
 * `await this.auth.ready` then `await new Promise(...)` then the
 * actual `_call`; each layer needs at least one microtask flush
 * between firing the resolver and observing the consequence.
 *
 * Calls in a small loop because some of the awaits chain three deep
 * (auth.ready → connect-wait → _call body).
 */
async function flushAwaits(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SocketTransport — in-flight requests across reconnect", () => {
  beforeEach(() => {
    _resetSockets();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetSockets();
  });

  // ── Queue: request issued while disconnected ────────────────────────

  it("queues a GET until the socket connects, then fires it", async () => {
    const t = makeTransport(null); // unauth flow — auth.ready resolves immediately
    expect(t.isConnected).toBe(false);

    // Issue a request BEFORE connect. It should wait, not reject.
    const promise = t.get("/posts");
    await flushAwaits();

    // Nothing on the wire yet (auth.ready is resolved but we're still
    // waiting on the socket.once("connect") inside `fetch`).
    expect(allEmits("call").length).toBe(0);

    // Connect → the queued request fires.
    currentSocket.connect();
    await flushAwaits();

    // The `call` should have landed.
    const call = lastEmit("call");
    expect(call).toBeDefined();
    expect(call!.args[1]).toBe("GET");
    expect(call!.args[2]).toBe("/v1/posts");

    // Reply so the promise resolves cleanly.
    respondTo(call!, { result: { posts: [] }, success: true });
    const result = await promise;
    expect(result).toEqual({ posts: [] });
  });

  // ── Dedup: same-shape GET while in-flight ───────────────────────────

  it("dedupes concurrent GETs on the same path + body to one wire call", async () => {
    const t = makeTransport(null);
    currentSocket.connect();
    await flushAwaits();

    const p1 = t.get("/posts", { q: "hi" });
    const p2 = t.get("/posts", { q: "hi" });
    const p3 = t.get("/posts", { q: "different" });
    await flushAwaits();

    // Exactly TWO call emits — the duplicate dedupes, the different
    // one goes through.
    expect(allEmits("call").length).toBe(2);

    // Respond to both pending calls.
    const calls = allEmits("call");
    respondTo(calls[0]!, { result: { posts: [1] }, success: true });
    respondTo(calls[1]!, { result: { posts: [99] }, success: true });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    // p1 and p2 share the resolved value because they share the
    // promise instance.
    expect(r1).toBe(r2);
    expect(r1).toEqual({ posts: [1] });
    expect(r3).toEqual({ posts: [99] });
    void t;
  });

  it("clears the dedup slot on resolve so the next GET re-issues", async () => {
    const t = makeTransport(null);
    currentSocket.connect();
    await flushAwaits();

    const first = t.get("/posts");
    await flushAwaits();
    respondTo(lastEmit("call")!, { result: { posts: [] }, success: true });
    await first;
    await flushAwaits();

    // Issue the same shape again — should fly fresh, not return the
    // cached promise.
    const second = t.get("/posts");
    await flushAwaits();
    expect(allEmits("call").length).toBe(2);
    respondTo(lastEmit("call")!, { result: { posts: ["b"] }, success: true });
    expect(await second).toEqual({ posts: ["b"] });
    void t;
  });

  // ── Timeout: request fired, never answered ──────────────────────────

  it("rejects in-flight requests with RPC timeout and frees the dedup slot", async () => {
    const t = makeTransport(null);
    currentSocket.connect();
    await flushAwaits();

    const promise = t.get("/posts");
    await flushAwaits();
    // Pre-attach the rejection assertion so the timeout error has a
    // handler — otherwise `vi.advanceTimersByTimeAsync` surfaces it
    // as an unhandled rejection through vitest's process-level
    // listener.
    const settled = expect(promise).rejects.toThrow(/RPC timeout/);

    // No response, never disconnect — advance past the 120s default.
    await vi.advanceTimersByTimeAsync(120_001);
    await settled;
    await flushAwaits();

    // After the rejection the dedup slot is gone; a follow-up GET
    // emits a fresh `call`.
    const before = allEmits("call").length;
    const retry = t.get("/posts");
    await flushAwaits();
    expect(allEmits("call").length).toBe(before + 1);

    respondTo(lastEmit("call")!, { result: { posts: [] }, success: true });
    await retry;
    void t;
  });

  // ── In-flight across disconnect (the regression-shaped case) ────────

  it("a GET emitted before disconnect hangs across the gap and times out", async () => {
    const t = makeTransport(null);
    currentSocket.connect();
    await flushAwaits();

    const promise = t.get("/posts");
    await flushAwaits();
    expect(allEmits("call").length).toBe(1);

    const settled = expect(promise).rejects.toThrow(/RPC timeout/);

    // The server never responds; meanwhile the socket flaps.
    currentSocket.disconnect();
    currentSocket.connect();
    await flushAwaits();

    // The promise is still pending — the socket layer doesn't replay
    // the call, the server-side handler that owned the request is
    // gone. We expect the client-side timeout to be the failure
    // signal. The 120s timeout from `_call` is still ticking.
    await vi.advanceTimersByTimeAsync(120_001);
    await settled;
    void t;
  });

  it("a GET queued while disconnected waits across reconnect and fires once", async () => {
    const t = makeTransport(null);
    // Stays disconnected. Queue a request.
    const promise = t.get("/posts");
    await flushAwaits();

    // Still no call on the wire.
    expect(allEmits("call").length).toBe(0);

    const settled = expect(promise).rejects.toThrow(/RPC timeout/);

    // A brief connect → disconnect window. The request should resolve
    // on the first connect and fire exactly once even if the socket
    // immediately disconnects after.
    currentSocket.connect();
    await flushAwaits();
    expect(allEmits("call").length).toBe(1);
    currentSocket.disconnect();
    // No additional emit on the disconnect — that's by design; the
    // request is now in-flight and we don't replay it.
    expect(allEmits("call").length).toBe(1);

    // Reconnect: still one call (no replay).
    currentSocket.connect();
    await flushAwaits();
    expect(allEmits("call").length).toBe(1);

    // Timeout fires.
    await vi.advanceTimersByTimeAsync(120_001);
    await settled;
    void t;
  });

  // ── connect_error: queued requests reject cleanly ───────────────────

  it("a queued request rejects when the socket reports connect_error", async () => {
    const t = makeTransport(null);
    const promise = t.get("/posts");
    await flushAwaits();
    expect(allEmits("call").length).toBe(0);

    const settled = expect(promise).rejects.toThrow(/ECONNREFUSED/);
    // Fire connect_error before any successful connect.
    currentSocket._fire("connect_error", new Error("ECONNREFUSED"));
    await settled;
    void t;
  });

  // ── auth.ready gating ───────────────────────────────────────────────

  it("a request started while auth is pending waits for resolve before firing", async () => {
    const t = makeTransport("tok-abc");
    currentSocket.connect();
    await flushAwaits();
    // Token was set → authenticate fires but isn't answered yet.
    expect(allEmits("authenticate").length).toBe(1);

    const promise = t.get("/posts");
    await flushAwaits();
    expect(allEmits("call").length).toBe(0); // gated on auth.ready

    completeAuth("u1");
    await flushAwaits();
    expect(allEmits("call").length).toBe(1);

    respondTo(lastEmit("call")!, { result: { posts: [] }, success: true });
    await promise;
    void t;
  });

  it("re-authenticates with the existing token after a socket reconnect", async () => {
    const t = makeTransport("tok-abc");
    currentSocket.connect();
    await flushAwaits();
    expect(allEmits("authenticate")).toHaveLength(1);

    completeAuth("u1");
    expect(t.auth.state.status).toBe("authenticated");

    currentSocket.disconnect();
    expect(t.auth.state.status).toBe("pending");

    currentSocket.connect();
    await flushAwaits();

    // Regression for DOL-898: disconnect used to clear `token` to
    // undefined, so reconnect called _doAuth(), immediately bailed,
    // and never re-established auth/subscriptions unless Provider's
    // async getToken() happened to recover. The transport itself must
    // own reconnect re-auth using the still-valid session token.
    expect(allEmits("authenticate")).toHaveLength(2);
    completeAuth("u1");
    expect(t.auth.state.status).toBe("authenticated");
  });

  it("authenticate(same token) is a no-op once already authenticated", async () => {
    const t = makeTransport("tok-abc");
    currentSocket.connect();
    await flushAwaits();
    expect(allEmits("authenticate")).toHaveLength(1);

    completeAuth("u1");
    expect(t.auth.state.status).toBe("authenticated");

    const result = await t.authenticate("tok-abc");

    // Provider.onReconnect calls client.authenticate(token) after the
    // socket connect handler already kicked off _doAuth(). If the
    // token is unchanged and the transport is already authenticated,
    // authenticate() must not reset AuthGate back to pending or emit a
    // duplicate authenticate call.
    expect(result).toEqual({ userId: "u1" });
    expect(t.auth.state.status).toBe("authenticated");
    expect(allEmits("authenticate")).toHaveLength(1);
  });

  // ── isConnected getter / disconnect symmetry ────────────────────────

  it("isConnected flips back to false on disconnect even when token was set", () => {
    const t = makeTransport("tok-abc");
    currentSocket.connect();
    expect(t.isConnected).toBe(true);
    currentSocket.disconnect();
    expect(t.isConnected).toBe(false);
  });

  // ── Mutating requests (POST/PUT/PATCH/DELETE) don't dedupe ──────────

  it("non-GET requests don't dedupe — each call fires a fresh emit", async () => {
    const t = makeTransport(null);
    currentSocket.connect();
    await flushAwaits();

    const a = t.post("/posts", { title: "a" });
    const b = t.post("/posts", { title: "a" }); // identical body
    await flushAwaits();
    expect(allEmits("call").length).toBe(2);

    const calls = allEmits("call");
    respondTo(calls[0]!, { result: { id: "p1" }, success: true });
    respondTo(calls[1]!, { result: { id: "p2" }, success: true });

    const [r1, r2] = await Promise.all([a, b]);
    expect(r1).not.toBe(r2);
    expect(r1).toEqual({ id: "p1" });
    expect(r2).toEqual({ id: "p2" });
    void t;
  });

  // ── Server error responses surface cleanly ──────────────────────────

  it("server-side error responses reject with the server's message", async () => {
    const t = makeTransport(null);
    currentSocket.connect();
    await flushAwaits();

    const promise = t.get("/posts/missing");
    await flushAwaits();
    const settled = expect(promise).rejects.toThrow(/Forbidden/);
    respondTo(lastEmit("call")!, {
      result: null,
      success: false,
      error: "Forbidden",
    });
    await settled;
    void t;
  });
});
