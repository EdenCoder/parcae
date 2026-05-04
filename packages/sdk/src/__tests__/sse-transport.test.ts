/**
 * SSETransport — connect / disconnect / reconnect & EventSource
 * subscription lifecycle tests.
 *
 * Mocks the global `EventSource` constructor with an in-memory
 * fake so the transport runs deterministically with no real HTTP.
 * Tests the contract:
 *
 *   - constructor resolves the auth key asynchronously and emits
 *     "connected" once resolved
 *   - `disconnect()` closes every active EventSource and emits
 *     "disconnected"
 *   - `reconnect()` re-resolves the key and emits "connected"
 *   - `subscribe(event, handler)` returns an unsubscribe that
 *     closes the underlying EventSource and forgets the handler
 *   - listeners attached during a disconnected window survive
 *     across reconnect (each subscribe creates its own
 *     EventSource that the test can drive)
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ─── EventSource mock ───────────────────────────────────────────────────────

/**
 * In-memory EventSource. Tracks every constructed instance so
 * tests can drive incoming server messages and assert close()
 * was called on the right ones.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  closed = false;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  /** Test hook — push a message frame through the EventSource. */
  _push(data: any): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  /** Test hook — simulate a transport-level error frame. */
  _error(): void {
    this.onerror?.();
  }

  close(): void {
    this.closed = true;
  }

  static reset(): void {
    FakeEventSource.instances.length = 0;
  }
}

(globalThis as any).EventSource = FakeEventSource as any;

// ─── fetch mock (only `request()` uses it; subscribe uses EventSource) ──────

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler = async () => {
  return new Response(JSON.stringify({ success: true, result: {} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

(globalThis as any).fetch = vi.fn((url: string, init?: RequestInit) =>
  fetchHandler(url, init),
);

// Imports MUST come after the global stubs.
// eslint-disable-next-line import/first
import { SSETransport } from "../transports/sse";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTransport(opts: { key?: string | null } = {}) {
  return new SSETransport({
    url: "http://localhost:0",
    version: "v1",
    key: opts.key ?? "k",
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SSETransport — lifecycle & subscription flow", () => {
  beforeEach(() => {
    FakeEventSource.reset();
    fetchHandler = async () =>
      new Response(JSON.stringify({ success: true, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
  });

  afterEach(() => {
    FakeEventSource.reset();
  });

  // ── Initial state & connect ───────────────────────────────────────

  it("starts marked as connected (HTTP transports are 'always connected')", () => {
    const t = makeTransport();
    // The class doc says HTTP is "always connected" — pre-key
    // resolution we still report connected per its own contract.
    expect(t.isConnected).toBe(true);
  });

  it("emits 'connected' synchronously during construction when the key is a static string", () => {
    // Quirk worth documenting: with a static-string key,
    // `resolveKey()` has no await and runs to completion inside
    // the constructor — the emit happens BEFORE any external
    // `on("connected", …)` can attach. Consumers depending on
    // the event must use an async key resolver (next test) or
    // check `t.isConnected` at the call site instead. The
    // `loading` promise resolves cleanly either way.
    const t = makeTransport({ key: "static-k" });
    expect(t.isConnected).toBe(true);
    const onConnected = vi.fn();
    t.on("connected", onConnected);
    // No more emits — the listener is attached after the only
    // emit window closed.
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("emits 'connected' after an async key resolver settles (the supported attach window)", async () => {
    // With an async resolver, the body of `resolveKey()` is
    // suspended at `await this.apiKey()`, so consumer code can
    // attach `on("connected", …)` BEFORE the eventual emit. This
    // is the supported pattern for waiting on the key.
    const t = new SSETransport({
      url: "http://localhost:0",
      key: async () => "async-k",
    });
    const onConnected = vi.fn();
    t.on("connected", onConnected);
    await t.loading;
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(t.isConnected).toBe(true);
  });

  it("emits 'error' if the async key resolver throws", async () => {
    const t = new SSETransport({
      url: "http://localhost:0",
      key: async () => {
        throw new Error("auth fetch failed");
      },
    });
    const onError = vi.fn();
    t.on("error", onError);
    await t.loading.catch(() => {});
    expect(onError).toHaveBeenCalledTimes(1);
    const errArg = onError.mock.calls[0]?.[0] as Error;
    expect(errArg?.message).toBe("auth fetch failed");
  });

  // ── disconnect → "disconnected" event ─────────────────────────────

  it("emits 'disconnected' on disconnect() and flips isConnected", async () => {
    const t = makeTransport();
    await t.loading;
    const onDisconnected = vi.fn();
    t.on("disconnected", onDisconnected);
    t.disconnect();
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(t.isConnected).toBe(false);
  });

  it("disconnect() closes every open EventSource", async () => {
    const t = makeTransport();
    await t.loading;
    t.subscribe("a", () => {});
    t.subscribe("b", () => {});
    expect(FakeEventSource.instances.length).toBe(2);
    expect(FakeEventSource.instances.every((es) => !es.closed)).toBe(true);

    t.disconnect();
    expect(FakeEventSource.instances.every((es) => es.closed)).toBe(true);
  });

  // ── reconnect ─────────────────────────────────────────────────────

  it("reconnect() re-resolves the key and emits 'connected' again", async () => {
    const t = makeTransport();
    await t.loading;
    const onConnected = vi.fn();
    t.on("connected", onConnected);
    t.disconnect();
    expect(t.isConnected).toBe(false);
    await t.reconnect();
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(t.isConnected).toBe(true);
  });

  it("a full disconnect → reconnect cycle preserves transport-level listeners", async () => {
    const t = makeTransport();
    await t.loading;

    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    t.on("connected", onConnected);
    t.on("disconnected", onDisconnected);

    t.disconnect();
    await t.reconnect();
    t.disconnect();
    await t.reconnect();

    expect(onConnected).toHaveBeenCalledTimes(2);
    expect(onDisconnected).toHaveBeenCalledTimes(2);
  });

  // ── subscribe() — EventSource-backed listener API ─────────────────

  it("subscribe(event, handler) opens an EventSource for that event", async () => {
    const t = makeTransport();
    await t.loading;
    t.subscribe("project:patched", () => {});
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0]?.url).toContain(
      "/v1/__events/project%3Apatched",
    );
  });

  it("subscribe() forwards parsed JSON frames to the handler", async () => {
    const t = makeTransport();
    await t.loading;
    const handler = vi.fn();
    t.subscribe("evt", handler);
    const es = FakeEventSource.instances[0]!;
    es._push({ id: "p1", v: 1 });
    es._push({ id: "p2", v: 2 });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, { id: "p1", v: 1 });
    expect(handler).toHaveBeenNthCalledWith(2, { id: "p2", v: 2 });
  });

  it("subscribe() forwards raw strings if JSON.parse fails", async () => {
    const t = makeTransport();
    await t.loading;
    const handler = vi.fn();
    t.subscribe("evt", handler);
    const es = FakeEventSource.instances[0]!;
    es._push("not json");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("not json");
  });

  it("the unsubscribe returned by subscribe() closes the EventSource", async () => {
    const t = makeTransport();
    await t.loading;
    const handler = vi.fn();
    const unsub = t.subscribe("evt", handler);
    const es = FakeEventSource.instances[0]!;

    es._push({ x: 1 });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    expect(es.closed).toBe(true);
  });

  it("unsubscribe(event) closes the EventSource without invoking the handler", async () => {
    const t = makeTransport();
    await t.loading;
    const handler = vi.fn();
    t.subscribe("evt", handler);
    const es = FakeEventSource.instances[0]!;
    t.unsubscribe("evt");
    expect(es.closed).toBe(true);
  });

  it("subscribe() supports distinct events without cross-talk", async () => {
    const t = makeTransport();
    await t.loading;
    const a = vi.fn();
    const b = vi.fn();
    t.subscribe("event-a", a);
    t.subscribe("event-b", b);
    expect(FakeEventSource.instances.length).toBe(2);

    FakeEventSource.instances[0]!._push({ for: "a" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(0);

    FakeEventSource.instances[1]!._push({ for: "b" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  // ── Listener-survives-cycle (the regression-shaped tests) ─────────

  it("a subscribe added DURING the disconnected window opens a fresh EventSource on reconnect-and-resubscribe pattern", async () => {
    // SSE transport closes EventSources on disconnect(); the
    // contract for re-subscribe is "consumers re-call
    // subscribe() after observing 'connected'." This test
    // documents that contract: subscribe()'ing after disconnect
    // creates a new EventSource even while still 'disconnected',
    // and that EventSource then receives subsequent _push frames.
    const t = makeTransport();
    await t.loading;
    t.disconnect();
    expect(t.isConnected).toBe(false);

    const handler = vi.fn();
    const lateSub = t.subscribe("evt", handler);
    // A new EventSource is opened — count includes any auto-
    // closed pre-disconnect ones, so check the latest.
    const es =
      FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    expect(es.closed).toBe(false);

    await t.reconnect();
    es._push({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
    lateSub();
  });

  it("multiple transport-level listener attach/detach cycles do not leak prior listeners", async () => {
    const t = makeTransport();
    await t.loading;

    const onConnected = vi.fn();
    t.on("connected", onConnected);
    t.off("connected", onConnected);

    t.disconnect();
    await t.reconnect();

    // Detached listener should not see the new 'connected'.
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("EventSource onerror is a no-op (auto-reconnect handled by EventSource itself)", async () => {
    const t = makeTransport();
    await t.loading;
    const handler = vi.fn();
    t.subscribe("evt", handler);
    const es = FakeEventSource.instances[0]!;
    expect(() => es._error()).not.toThrow();
    // Handler not called for errors — only data frames.
    expect(handler).not.toHaveBeenCalled();
  });
});
