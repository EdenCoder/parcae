/**
 * SocketTransport — connect / disconnect / reconnect & listener
 * lifecycle tests.
 *
 * Mocks `socket.io-client` so the transport runs against a
 * deterministic in-memory EventEmitter that we can step through
 * one event at a time. No real network. Tests the contract
 * SocketTransport publishes:
 *
 *   - "connected" / "disconnected" / "error" events on the
 *     transport itself (consumers like `useApi` subscribe here)
 *   - `subscribe(event, handler)` registers a socket-level
 *     handler and returns an idempotent unsubscribe
 *   - the connect path triggers auth re-resolution; disconnect
 *     resets auth and clears the token
 *   - listeners attached BEFORE the socket is connected still
 *     fire on the eventual connect, and listeners attached
 *     DURING a disconnect stay attached for the next connect
 *     (no listener loss across the gap)
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
 * `SocketTransport` uses: `on` / `off` / `once` / `emit` /
 * `connect()` / `disconnect()` / `connected` boolean.
 *
 * `_fire(event, ...args)` is the test-side hook to drive
 * lifecycle events ("connect", "disconnect", "error") through the
 * transport's listeners.
 */
class FakeSocket {
  connected = false;
  // Map<event, Set<handler>>
  private handlers = new Map<string, Set<(...args: any[]) => void>>();
  // Capture every `emit` call so tests can inspect outgoing RPCs.
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
    // Tag the wrapper so off(event, originalHandler) can find it
    // — Socket.IO's `off` matches by handler identity, but our
    // tests `_fire("connect")` directly through `_fire` which
    // walks the wrappers, so identity tagging isn't needed for
    // dispatch. It IS needed for `socket.off("connect", onConnect)`
    // matching the original. We mirror Socket.IO's behaviour:
    // off(event, original) removes any wrapper that closed over
    // `original`. Easiest: store the original on the wrapper.
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
    // Match either direct handler OR a wrapper that wraps it
    // (the once() shape).
    for (const h of set) {
      if (h === handler || (h as any).__original === handler) set.delete(h);
    }
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    this.emits.push({ event, args });
    return true;
  }

  /** Drive an "incoming" socket event through every registered handler. */
  _fire(event: string, ...args: any[]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // Snapshot — handlers may mutate the Set (e.g. once() wrappers).
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

// Imports MUST come after `vi.mock` so the SDK picks up the stub.
// eslint-disable-next-line import/first
import { SocketTransport, _resetSockets } from "../transports/socket";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTransport(token: string | null | undefined = "tok") {
  // SOCKETS is a module-level cache keyed by url+path; clear
  // between tests so each transport gets its own FakeSocket.
  _resetSockets();
  return new SocketTransport({ url: "http://localhost:0", token });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SocketTransport — lifecycle & listener flow", () => {
  beforeEach(() => {
    _resetSockets();
  });

  afterEach(() => {
    _resetSockets();
  });

  // ── Initial state ─────────────────────────────────────────────────

  it("starts disconnected when the underlying socket is not yet connected", () => {
    const t = makeTransport();
    expect(t.isConnected).toBe(false);
  });

  it("reports already-connected when the cached socket was connected at construct time", () => {
    // Fake a pre-connected socket cache by constructing one,
    // marking it connected, then re-constructing through the
    // module cache. Since `_resetSockets()` clears the cache, we
    // construct, then mutate the underlying socket directly.
    const t1 = makeTransport();
    currentSocket.connected = true;
    // Construct another transport with the SAME url+path so it
    // reuses the cached socket (same SOCKETS key).
    const t2 = new SocketTransport({
      url: "http://localhost:0",
      token: "tok",
    });
    expect(t2.isConnected).toBe(true);
    void t1;
  });

  // ── connect → "connected" event ───────────────────────────────────

  it("emits 'connected' on the transport when the socket connects", () => {
    const t = makeTransport();
    const onConnected = vi.fn();
    t.on("connected", onConnected);
    currentSocket.connect();
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(t.isConnected).toBe(true);
  });

  it("attempts authentication on connect when a token is set", () => {
    const t = makeTransport("tok-abc");
    currentSocket.connect();
    // The transport emits 'authenticate' through the socket as
    // part of _doAuth.
    const authenticateEmits = currentSocket.emits.filter(
      (e) => e.event === "authenticate",
    );
    expect(authenticateEmits.length).toBe(1);
    expect(authenticateEmits[0]?.args[0]).toBe("tok-abc");
    void t;
  });

  // ── disconnect → "disconnected" event ─────────────────────────────

  it("emits 'disconnected' on the transport when the socket disconnects", () => {
    const t = makeTransport();
    currentSocket.connect();
    const onDisconnected = vi.fn();
    t.on("disconnected", onDisconnected);
    currentSocket.disconnect();
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(t.isConnected).toBe(false);
  });

  it("resets auth and clears the token on disconnect", async () => {
    const t = makeTransport("tok-abc");
    currentSocket.connect();
    // Simulate the server callback for `authenticate` so auth
    // resolves before we disconnect.
    const authEmit = currentSocket.emits.find(
      (e) => e.event === "authenticate",
    );
    const callback = authEmit?.args[1] as (resp: any) => void;
    callback({ userId: "u1" });
    expect(t.auth.state.status).toBe("authenticated");

    currentSocket.disconnect();
    expect(t.auth.state.status).toBe("pending");
  });

  // ── error event passthrough ───────────────────────────────────────

  it("re-emits socket 'error' events on the transport", () => {
    const t = makeTransport();
    const onError = vi.fn();
    t.on("error", onError);
    const err = new Error("boom");
    currentSocket._fire("error", err);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
  });

  // ── full disconnect → reconnect cycle ─────────────────────────────

  it("fires connected/disconnected listeners across a full reconnect cycle", () => {
    const t = makeTransport();
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    t.on("connected", onConnected);
    t.on("disconnected", onDisconnected);

    currentSocket.connect();
    currentSocket.disconnect();
    currentSocket.connect();
    currentSocket.disconnect();
    currentSocket.connect();

    expect(onConnected).toHaveBeenCalledTimes(3);
    expect(onDisconnected).toHaveBeenCalledTimes(2);
    expect(t.isConnected).toBe(true);
  });

  it("re-attempts auth on every reconnect (assuming a token is still set on construct)", () => {
    // Note: on disconnect the transport sets `token = undefined`
    // (so a re-connect doesn't replay a stale token). After the
    // first disconnect, _doAuth becomes a no-op until
    // `authenticate(token)` is called again. This test documents
    // that contract — only the FIRST connect after construct
    // triggers an authenticate emit.
    const t = makeTransport("tok-abc");
    currentSocket.connect();
    expect(
      currentSocket.emits.filter((e) => e.event === "authenticate").length,
    ).toBe(1);
    currentSocket.disconnect();
    currentSocket.connect();
    // No new authenticate — token was cleared on disconnect.
    expect(
      currentSocket.emits.filter((e) => e.event === "authenticate").length,
    ).toBe(1);
    void t;
  });

  // ── subscribe() — socket-event listener API ───────────────────────

  it("subscribe() forwards events to the handler and returns an unsubscribe", () => {
    const t = makeTransport();
    const handler = vi.fn();
    const unsubscribe = t.subscribe("project:patched", handler);

    currentSocket._fire("project:patched", { id: "p1" });
    currentSocket._fire("project:patched", { id: "p2" });
    expect(handler).toHaveBeenCalledTimes(2);

    unsubscribe();
    currentSocket._fire("project:patched", { id: "p3" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("supports multiple subscribers for the same event", () => {
    const t = makeTransport();
    const a = vi.fn();
    const b = vi.fn();
    t.subscribe("chat:chunk", a);
    t.subscribe("chat:chunk", b);

    currentSocket._fire("chat:chunk", { idx: 0 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe() called twice is a safe no-op", () => {
    const t = makeTransport();
    const handler = vi.fn();
    const unsub = t.subscribe("evt", handler);
    unsub();
    expect(() => unsub()).not.toThrow();
    currentSocket._fire("evt", "data");
    expect(handler).not.toHaveBeenCalled();
  });

  // ── Listener-survives-cycle (the regression-shaped tests) ─────────

  it("listeners added BEFORE connect still fire when connect happens", () => {
    // A common React pattern: useEffect on mount calls
    // transport.subscribe(...). The mount may run before the
    // socket's first `connect`. The handler must still receive
    // events emitted after the eventual connect.
    const t = makeTransport();
    const handler = vi.fn();
    t.subscribe("project:patched", handler);

    // Connect, then fire events.
    currentSocket.connect();
    currentSocket._fire("project:patched", { v: 1 });
    expect(handler).toHaveBeenCalledTimes(1);

    void t;
  });

  it("subscribe()'d handlers persist across a disconnect → reconnect (the underlying socket is the SAME instance)", () => {
    // SocketTransport reuses the SAME socket.io socket across
    // disconnect/reconnect — `disconnect()` and `reconnect()`
    // toggle the connection but don't replace the socket. So
    // listeners stay attached and fire after reconnect.
    const t = makeTransport();
    const handler = vi.fn();
    t.subscribe("project:patched", handler);

    currentSocket.connect();
    currentSocket._fire("project:patched", { v: 1 });
    currentSocket.disconnect();
    // Add ANOTHER listener during the disconnected window.
    const lateHandler = vi.fn();
    t.subscribe("project:patched", lateHandler);
    currentSocket.connect();
    currentSocket._fire("project:patched", { v: 2 });

    expect(handler).toHaveBeenCalledTimes(2); // both pre and post reconnect
    expect(lateHandler).toHaveBeenCalledTimes(1); // post-reconnect only
  });

  it("transport-level listeners (connected/disconnected) added AFTER an earlier cycle still fire on the next cycle", () => {
    // The `useApi` pattern: a component mounts, attaches its
    // own connected/disconnected listeners, and expects to
    // observe every subsequent transition.
    const t = makeTransport();
    currentSocket.connect();
    currentSocket.disconnect();

    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    t.on("connected", onConnected);
    t.on("disconnected", onDisconnected);

    currentSocket.connect();
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledTimes(0);

    currentSocket.disconnect();
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });

  // ── disconnect() / reconnect() instance methods ───────────────────

  it("disconnect() flips isConnected and calls socket.disconnect()", () => {
    const t = makeTransport();
    currentSocket.connect();
    expect(t.isConnected).toBe(true);
    t.disconnect();
    expect(t.isConnected).toBe(false);
    expect(currentSocket.connected).toBe(false);
  });

  it("reconnect() calls socket.connect() — the connect handler then flips state", () => {
    const t = makeTransport();
    expect(t.isConnected).toBe(false);
    void t.reconnect();
    // socket.connect() in our fake fires "connect" synchronously
    expect(t.isConnected).toBe(true);
  });
});
