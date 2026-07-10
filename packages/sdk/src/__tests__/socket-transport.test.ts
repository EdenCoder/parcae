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
import { compress } from "compress-json";
import pako from "pako";
import { FrontendAdapter, Model } from "@parcae/model";

class FakeSocket {
  connected = false;
  disconnectCalls = 0;
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
    this.disconnectCalls++;
    this.connected = false;
    this._fire("disconnect");
  }
}

let currentSocket: FakeSocket;
let sockets: FakeSocket[] = [];

vi.mock("socket.io-client", () => ({
  default: vi.fn(() => {
    currentSocket = new FakeSocket();
    sockets.push(currentSocket);
    return currentSocket;
  }),
}));

// eslint-disable-next-line import/first
import { SocketTransport } from "../transports/socket";
import { createClient } from "../client";

function makeTransport(getToken: () => Promise<string | null>) {
  return new SocketTransport({ url: "http://localhost:0", getToken });
}

/** Drain the most recent `hello` emit's callback with a fake server response. */
function ackHello(userId: string | null): void {
  const hello = [...currentSocket.emits].reverse().find((e) => e.event === "hello");
  if (!hello) throw new Error("no hello emit found");
  const cb = hello.args[1] as (resp: any) => void;
  cb({ userId });
}

function respondToLatestCall(response: Record<string, unknown>): void {
  const call = [...currentSocket.emits].reverse().find((e) => e.event === "call");
  if (!call) throw new Error("no call emit found");
  const requestId = call.args[0] as string;
  currentSocket._fire(
    requestId,
    pako.gzip(JSON.stringify(compress(response))),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class Post extends Model {
  static type = "post" as const;
}

describe("SocketTransport — hello/resync protocol", () => {
  beforeEach(() => {
    sockets = [];
  });
  afterEach(() => {
    vi.useRealTimers();
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

  it("disconnect always cancels an underlying connecting socket", () => {
    const transport = makeTransport(async () => "token");

    transport.disconnect();

    expect(currentSocket.disconnectCalls).toBe(1);
    expect(transport.connection.state.status).toBe("disconnected");
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

  it("refreshSession() after termination revives the session (sign-out → sign-in flow)", async () => {
    let token: string | null = "tok-1";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("u-1");
    expect(t.session.state.status).toBe("authenticated");

    // Sign out — terminates the machine.
    token = null;
    const termPromise = t.terminateSession();
    const helloOut = [...currentSocket.emits].reverse().find((e) => e.event === "hello");
    if (helloOut) (helloOut.args[1] as (r: any) => void)({ userId: null });
    await termPromise;
    expect(t.session.state.status).toBe("terminated");

    // Sign back in — same client, new token. Without revival, the
    // session machine would stay "terminated" and resolve(userId)
    // would no-op, leaving consumers stuck on the sign-in gate.
    token = "tok-2";
    const refreshPromise = t.refreshSession();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("u-2");
    const result = await refreshPromise;

    expect(result).toEqual({ userId: "u-2" });
    expect(t.session.state.status).toBe("authenticated");
    expect(t.session.state.userId).toBe("u-2");
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

  it("preserves protocol status and code on RPC errors", async () => {
    const transport = makeTransport(async () => "tok");
    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("u-1");

    const request = transport.get("/posts/missing");
    await Promise.resolve();
    respondToLatestCall({
      success: false,
      error: "Post not found",
      status: 404,
      code: "NOT_FOUND",
    });

    const error = await request.catch((reason) => reason);
    expect(error).toMatchObject({
      message: "Post not found",
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("settles FrontendAdapter.findById as null for a socket 404", async () => {
    const transport = makeTransport(async () => "tok");
    const adapter = new FrontendAdapter(transport);
    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("u-1");

    const request = adapter.findById(Post, "missing");
    await Promise.resolve();
    respondToLatestCall({
      success: false,
      error: "Post not found",
      status: 404,
    });

    await expect(request).resolves.toBeNull();
  });

  it("does not share sockets or disconnect sibling transports", () => {
    const first = makeTransport(async () => "first");
    const firstSocket = currentSocket;
    const second = makeTransport(async () => "second");
    const secondSocket = currentSocket;

    expect(firstSocket).not.toBe(secondSocket);
    secondSocket.connect();
    first.disconnect();

    expect(secondSocket.connected).toBe(true);
    expect(second.connection.state.status).toBe("connected");
    first.dispose();
    second.dispose();
  });

  it("createClient never aliases clients with different identity configuration", () => {
    const first = createClient({
      url: "http://localhost:0",
      version: "v1",
      getToken: async () => "first",
      extraHeaders: { "x-provider": "first" },
    });
    const second = createClient({
      url: "http://localhost:0",
      version: "v2",
      getToken: async () => "second",
      extraHeaders: { "x-provider": "second" },
    });

    expect(first).not.toBe(second);
    expect(first.transport).not.toBe(second.transport);
    expect(sockets).toHaveLength(2);
    first.dispose();
    second.dispose();
  });

  it("keeps model adapters explicit across disposed and replacement clients", () => {
    class ClientPost extends Model {
      static type = "client-post" as const;
    }
    const first = createClient({
      url: "http://localhost:0",
      getToken: async () => "first",
    });
    const FirstPost = first.bind(ClientPost);
    first.dispose();
    const second = createClient({
      url: "http://localhost:0",
      getToken: async () => "second",
    });
    const SecondPost = second.bind(ClientPost);

    expect(ClientPost.hasAdapter()).toBe(false);
    expect(FirstPost.getAdapter()).toBe(first.adapter);
    expect(SecondPost.getAdapter()).toBe(second.adapter);
    expect(second.transport).not.toBe(first.transport);
    second.dispose();
  });

  it("ignores stale token completions from an older handshake generation", async () => {
    const firstToken = deferred<string | null>();
    const secondToken = deferred<string | null>();
    const getToken = vi
      .fn<() => Promise<string | null>>()
      .mockReturnValueOnce(firstToken.promise)
      .mockReturnValueOnce(secondToken.promise);
    const transport = makeTransport(getToken);
    currentSocket.connect();

    const refresh = transport.refreshSession();
    secondToken.resolve("new-token");
    await Promise.resolve();
    await Promise.resolve();
    ackHello("new-user");
    await refresh;

    firstToken.resolve("old-token");
    await Promise.resolve();
    await Promise.resolve();

    expect(transport.session.state.userId).toBe("new-user");
    expect(currentSocket.emits.filter((entry) => entry.event === "hello")).toHaveLength(1);
  });

  it("ignores a stale hello acknowledgement after a newer identity wins", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    const firstHello = currentSocket.emits.find((entry) => entry.event === "hello")!;

    const refresh = transport.refreshSession();
    await Promise.resolve();
    await Promise.resolve();
    const helloEmits = currentSocket.emits.filter((entry) => entry.event === "hello");
    const secondHello = helloEmits[1]!;
    (secondHello.args[1] as (response: any) => void)({ userId: "new-user" });
    await refresh;

    (firstHello.args[1] as (response: any) => void)({ userId: "old-user" });
    expect(transport.session.state.userId).toBe("new-user");
  });

  it("rejects hello readiness when token resolution exceeds the bound", async () => {
    vi.useFakeTimers();
    const transport = new SocketTransport({
      url: "http://localhost:0",
      getToken: () => new Promise(() => {}),
      handshakeTimeout: 25,
    });
    currentSocket.connect();
    const ready = transport.reconnect();
    const rejection = expect(ready).rejects.toThrow("Hello timeout");

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
  });

  it("rejects hello readiness on disconnect and missing acknowledgements", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    const disconnected = transport.reconnect();
    currentSocket.disconnect();
    await expect(disconnected).rejects.toThrow("Disconnected");

    const reconnect = transport.reconnect();
    await Promise.resolve();
    await Promise.resolve();
    const hello = [...currentSocket.emits].reverse().find((entry) => entry.event === "hello")!;
    (hello.args[1] as (response?: any) => void)();
    await expect(reconnect).rejects.toThrow("Missing hello acknowledgement");
  });

  it("starts a fresh handshake when reconnect follows a failed hello", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    const failedHello = currentSocket.emits.find((entry) => entry.event === "hello")!;
    (failedHello.args[1] as (response: any) => void)({
      success: false,
      error: "denied",
    });

    const reconnect = transport.reconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(currentSocket.emits.filter((entry) => entry.event === "hello")).toHaveLength(2);
    ackHello("user");

    await expect(reconnect).resolves.toBeUndefined();
    expect(transport.session.state.userId).toBe("user");
  });

  it("reconnect waits for both socket connection and hello", async () => {
    const token = deferred<string | null>();
    const transport = makeTransport(() => token.promise);
    let settled = false;
    const reconnect = transport.reconnect().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    token.resolve("token");
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    ackHello("user");
    await reconnect;
    expect(settled).toBe(true);
  });

  it("connect_error rejects reconnect and updates connection state", async () => {
    const transport = makeTransport(async () => "token");
    const error = new Error("refused");
    currentSocket.connect = () => {
      currentSocket._fire("connect_error", error);
    };

    await expect(transport.reconnect()).rejects.toThrow("refused");
    expect(transport.connection.state.status).toBe("disconnected");
    expect(transport.connection.state.lastError).toBe(error);
  });

  it("deduplicates GETs only within the current session generation", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("user-1");

    const first = transport.get("/posts", { page: 1 }).catch((error) => error);
    const duplicate = transport.get("/posts", { page: 1 }).catch((error) => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(currentSocket.emits.filter((entry) => entry.event === "call")).toHaveLength(1);

    const refresh = transport.refreshSession();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("user-2");
    await refresh;
    const nextGeneration = transport
      .get("/posts", { page: 1 })
      .catch((error) => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(currentSocket.emits.filter((entry) => entry.event === "call")).toHaveLength(2);

    transport.dispose();
    await Promise.all([first, duplicate, nextGeneration]);
  });

  it("rejects pending RPC and resync acknowledgements on disconnect", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("user");

    const call = transport.get("/posts");
    const resync = transport.resync([
      { key: "posts", modelType: "post", steps: [] },
    ]);
    const callRejection = expect(call).rejects.toThrow("Disconnected");
    const resyncRejection = expect(resync).rejects.toThrow("Disconnected");
    await Promise.resolve();
    await Promise.resolve();
    currentSocket.disconnect();

    await callRejection;
    await resyncRejection;
  });

  it("rejects an RPC when a fresh session generation starts", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("user-1");

    const call = transport.get("/posts");
    await Promise.resolve();
    const rejection = expect(call).rejects.toThrow("Hello superseded");
    const refresh = transport.refreshSession();
    await rejection;
    await Promise.resolve();
    await Promise.resolve();
    ackHello("user-2");
    await refresh;
  });

  it("forwards application socket errors without rejecting unrelated RPCs", async () => {
    const transport = makeTransport(async () => "token");
    const onError = vi.fn();
    transport.on("error", onError);
    currentSocket.connect();
    await Promise.resolve();
    await Promise.resolve();
    ackHello("user");

    const request = transport.get("/posts");
    await Promise.resolve();
    const applicationError = new Error("application warning");
    currentSocket._fire("error", applicationError);
    respondToLatestCall({ success: true, result: { posts: [] } });

    await expect(request).resolves.toEqual({ posts: [] });
    expect(onError).toHaveBeenCalledWith(applicationError);
    expect(transport.connection.state.status).toBe("connected");
  });

  it("rejects connection waiters on dispose", async () => {
    const transport = makeTransport(async () => "token");
    currentSocket.connect = () => {};
    const reconnect = transport.reconnect();
    const rejection = expect(reconnect).rejects.toThrow("Transport disposed");

    transport.dispose();

    await rejection;
  });
});
