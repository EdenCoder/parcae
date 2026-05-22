/**
 * SocketTransport — hello/resync protocol + lifecycle contract.
 *
 * The transport runs against a deterministic FakeSocket (in-memory
 * EventEmitter mock of socket.io-client). Tests cover:
 *
 *   - `hello` fires once per connect, populates SessionMachine.
 *   - `disconnect` does NOT mutate SessionMachine.
 *   - reconnect emits `resync-required` exactly once per hello ack.
 *   - `refreshSession()` re-runs the hello handshake.
 *   - `terminateSession()` puts the SessionMachine into terminated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  removeAllListeners(): void {
    this.handlers.clear();
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

function makeTransport(getToken: () => Promise<string | null>) {
  _resetSockets();
  return new SocketTransport({ url: "http://localhost:0", getToken });
}

/** Drain the most recent `hello` emit's callback with a fake server response. */
function ackHello(userId: string | null): void {
  const hello = [...currentSocket.emits].reverse().find((e) => e.event === "hello");
  if (!hello) throw new Error("no hello emit found");
  const cb = hello.args[1] as (resp: any) => void;
  cb({ userId });
}

describe("SocketTransport — hello/resync protocol", () => {
  beforeEach(() => {
    _resetSockets();
  });
  afterEach(() => {
    _resetSockets();
  });

  it("starts in connecting and flips to connected on socket connect", () => {
    const t = makeTransport(async () => "tok");
    expect(t.connection.state.status).toBe("connecting");
    currentSocket.connect();
    expect(t.connection.state.status).toBe("connected");
  });

  it("emits hello with the token after connect and resolves the session on ack", async () => {
    const t = makeTransport(async () => "tok-1");
    currentSocket.connect();

    // Yield twice so getToken().then(emit hello) chain settles.
    await Promise.resolve();
    await Promise.resolve();

    const hello = currentSocket.emits.find((e) => e.event === "hello");
    expect(hello).toBeDefined();
    expect(hello!.args[0]).toEqual({ token: "tok-1" });

    expect(t.session.state.status).toBe("pending");
    ackHello("u-42");
    expect(t.session.state.status).toBe("authenticated");
    expect(t.session.state.userId).toBe("u-42");
  });

  it("hello with null token resolves anonymous", async () => {
    const t = makeTransport(async () => null);
    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    ackHello(null);
    expect(t.session.state.status).toBe("anonymous");
    expect(t.session.state.userId).toBeNull();
  });

  it("token resolver failure leaves the session pending and does not send anonymous hello", async () => {
    const t = makeTransport(async () => {
      throw new Error("auth endpoint unavailable");
    });
    const onError = vi.fn();
    const onResync = vi.fn();
    t.on("error", onError);
    t.on("resync-required", onResync);

    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(currentSocket.emits.filter((e) => e.event === "hello")).toHaveLength(0);
    expect(t.session.state.status).toBe("pending");
    expect(t.session.state.userId).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onResync).not.toHaveBeenCalled();
  });

  it("disconnect does NOT mutate the SessionMachine", async () => {
    const t = makeTransport(async () => "tok");
    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("u-1");
    expect(t.session.state.status).toBe("authenticated");

    currentSocket.disconnect();

    expect(t.connection.state.status).toBe("disconnected");
    expect(t.session.state.status).toBe("authenticated");
    expect(t.session.state.userId).toBe("u-1");
  });

  it("emits resync-required exactly once per hello ack", async () => {
    const t = makeTransport(async () => "tok");
    const onResync = vi.fn();
    t.on("resync-required", onResync);

    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("u-1");
    expect(onResync).toHaveBeenCalledTimes(1);

    currentSocket.disconnect();
    expect(onResync).toHaveBeenCalledTimes(1);

    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("u-1");
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it("refreshSession() re-emits hello and updates the session", async () => {
    let token: string | null = "tok-1";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("u-1");

    token = "tok-2";
    const promise = t.refreshSession();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("u-2");
    const result = await promise;

    expect(result).toEqual({ userId: "u-2" });
    expect(t.session.state.userId).toBe("u-2");
  });

  it("terminateSession() locks the session machine", async () => {
    const t = makeTransport(async () => "tok");
    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("u-1");

    // The terminate path emits a final hello to clear the socket
    // session server-side. Ack it so the await resolves.
    const promise = t.terminateSession();
    // hello has 2 args; capture and ack with no userId.
    const helloAfter = [...currentSocket.emits].reverse().find((e) => e.event === "hello");
    if (helloAfter) {
      const cb = helloAfter.args[1] as (resp: any) => void;
      cb({ userId: null });
    }
    await promise;

    expect(t.session.state.status).toBe("terminated");
  });

  it("resync RPC sends a queries envelope and resolves with the results", async () => {
    const t = makeTransport(async () => "tok");
    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("u-1");

    const promise = t.resync([
      {
        key: "post:u-1:[]",
        modelType: "post",
        steps: [],
      },
    ]);

    // Flush the `await helloReady` microtask so the resync emit lands.
    await Promise.resolve();
    await Promise.resolve();

    const resyncEmit = [...currentSocket.emits].reverse().find((e) => e.event === "resync");
    expect(resyncEmit).toBeDefined();
    expect(resyncEmit!.args[0]).toEqual({
      queries: [{ key: "post:u-1:[]", modelType: "post", steps: [] }],
    });

    const cb = resyncEmit!.args[1] as (resp: any) => void;
    cb({
      success: true,
      results: [
        {
          key: "post:u-1:[]",
          hash: "h-1",
          items: [{ id: "p1" }],
          totalCount: 1,
        },
      ],
    });

    const results = await promise;
    expect(results).toHaveLength(1);
    expect(results[0]!.hash).toBe("h-1");
  });
});
