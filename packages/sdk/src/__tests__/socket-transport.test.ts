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

class FakeSocket {
  connected = false;
  connectOnCall = true;
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

  _handlerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  _fire(event: string, ...args: any[]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of [...set]) h(...args);
  }

  connect(): void {
    if (!this.connectOnCall) return;
    this.connected = true;
    this._fire("connect");
  }

  disconnect(): void {
    this.connected = false;
    this._fire("disconnect");
  }
}

let currentSocket: FakeSocket;
const sockets: FakeSocket[] = [];
const socketConfigs: Array<{
  transports: string[];
  extraHeaders?: Record<string, string>;
}> = [];

vi.mock("socket.io-client", () => ({
  default: vi.fn((_url: string, config: any) => {
    currentSocket = new FakeSocket();
    sockets.push(currentSocket);
    socketConfigs.push(config);
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
async function ackHello(userId: string | null): Promise<void> {
  const hello = [...currentSocket.emits]
    .reverse()
    .find((e) => e.event === "hello");
  if (!hello) throw new Error("no hello emit found");
  const cb = hello.args[1] as (resp: any) => void;
  cb({ userId });
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForNewEmit(
  event: string,
  previousCount: number,
): Promise<{ event: string; args: any[] }> {
  let latest: { event: string; args: any[] } | undefined;
  await vi.waitFor(() => {
    const matches = currentSocket.emits.filter(
      (entry) => entry.event === event,
    );
    expect(matches.length).toBeGreaterThan(previousCount);
    latest = matches.at(-1);
  });
  return latest!;
}

function respondToCall(
  call: { event: string; args: any[] },
  result: unknown,
): void {
  const requestId = call.args[0] as string;
  currentSocket._fire(
    requestId,
    pako.gzip(JSON.stringify(compress({ success: true, result }))),
  );
}

describe("SocketTransport — hello/resync protocol", () => {
  beforeEach(() => {
    _resetSockets();
    sockets.length = 0;
    socketConfigs.length = 0;
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

  it("still starts hello when a connection listener throws", async () => {
    const t = makeTransport(async () => "tok");
    t.connection.subscribe(() => {
      if (t.connection.state.status === "connected") {
        throw new Error("consumer listener failed");
      }
    });

    currentSocket.connect();
    const hello = await waitForNewEmit("hello", 0);
    expect(hello.args[0]).toEqual({ token: "tok" });
  });

  it("isolates physical sockets across API versions", () => {
    const versionOne = new SocketTransport({
      url: "http://localhost:0",
      version: "v1",
      getToken: async () => "tok-v1",
    });
    const socketOne = currentSocket;
    const versionTwo = new SocketTransport({
      url: "http://localhost:0",
      version: "v2",
      getToken: async () => "tok-v2",
    });
    const socketTwo = currentSocket;

    expect(socketOne).not.toBe(socketTwo);
    socketOne.connect();
    socketTwo.connect();
    versionOne.disconnect();

    expect(socketOne.connected).toBe(false);
    expect(socketTwo.connected).toBe(true);
    expect(versionTwo.connection.state.status).toBe("connected");
  });

  it("snapshots caller-owned transports and headers before socket creation", () => {
    const transports: Array<"websocket" | "polling"> = ["websocket"];
    const extraHeaders = { "x-tenant": "tenant-a" };

    new SocketTransport({
      url: "http://localhost:0",
      getToken: async () => "tok",
      transports,
      extraHeaders,
    });
    const socketConfig = socketConfigs.at(-1)!;

    transports[0] = "polling";
    extraHeaders["x-tenant"] = "tenant-b";

    expect(socketConfig.transports).toEqual(["websocket"]);
    expect(socketConfig.extraHeaders).toEqual({ "x-tenant": "tenant-a" });
  });

  it("scrubs the owned token resolver when its Provider lease is released", async () => {
    const t = makeTransport(async () => "initial-token");
    const lease = {};
    const ownedResolver = vi.fn(async () => "provider-token");
    t.acquireTokenResolverLease(lease, ownedResolver);
    expect((t as any).getToken).toBe(ownedResolver);

    expect(t.releaseTokenResolverLease(lease)).toBe(true);
    expect((t as any).getToken).not.toBe(ownedResolver);

    currentSocket.connect();
    const hello = await waitForNewEmit("hello", 0);
    expect(hello.args[0]).toEqual({ token: null });
    expect(ownedResolver).not.toHaveBeenCalled();
  });

  it("emits hello with the token after connect and resolves the session on ack", async () => {
    const t = makeTransport(async () => "tok-1");
    currentSocket.connect();

    const hello = await waitForNewEmit("hello", 0);
    expect(hello.args[0]).toEqual({ token: "tok-1" });

    expect(t.session.state.status).toBe("pending");
    await ackHello("u-42");
    expect(t.session.state.status).toBe("authenticated");
    expect(t.session.state.userId).toBe("u-42");
  });

  it("hello with null token resolves anonymous", async () => {
    const t = makeTransport(async () => null);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello(null);
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
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });

    expect(currentSocket.emits.filter((e) => e.event === "hello")).toHaveLength(
      0,
    );
    expect(t.session.state.status).toBe("pending");
    expect(t.session.state.userId).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onResync).not.toHaveBeenCalled();
  });

  it("disconnect does NOT mutate the SessionMachine", async () => {
    const t = makeTransport(async () => "tok");
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");
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
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");
    expect(onResync).toHaveBeenCalledTimes(1);

    currentSocket.disconnect();
    expect(onResync).toHaveBeenCalledTimes(1);

    currentSocket.connect();
    await waitForNewEmit("hello", 1);
    await ackHello("u-1");
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it("refreshSession() re-emits hello and updates the session", async () => {
    let token: string | null = "tok-1";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    token = "tok-2";
    const helloCount = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    ).length;
    const promise = t.refreshSession();
    const hello = await waitForNewEmit("hello", helloCount);
    (hello.args[1] as (response: any) => void)({ userId: "u-2" });
    const result = await promise;

    expect(result).toEqual({ userId: "u-2" });
    expect(t.session.state.userId).toBe("u-2");
  });

  it("reconciles a replaced token resolver before a direct cached-client RPC", async () => {
    let token = "tok-1";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    token = "tok-2";
    t.updateTokenResolver(async () => token);
    const helloCount = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    ).length;
    const request = t.post("/invites/use", { code: "example" });
    const hello = await waitForNewEmit("hello", helloCount);

    expect(hello.args[0]).toEqual({ token: "tok-2" });
    expect(
      currentSocket.emits.filter((entry) => entry.event === "call"),
    ).toHaveLength(0);

    (hello.args[1] as (response: any) => void)({ userId: "u-2" });
    const call = await waitForNewEmit("call", 0);
    expect(t.session.state.userId).toBe("u-2");

    respondToCall(call, { accepted: true });
    await expect(request).resolves.toEqual({ accepted: true });
  });

  it("reconciles a reused stable resolver before a direct cached-client RPC", async () => {
    let token = "tok-1";
    const stableResolver = async () => token;
    const t = makeTransport(stableResolver);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    token = "tok-2";
    t.updateTokenResolver(stableResolver);
    const request = t.post("/invites/use", { code: "example" });
    const hello = await waitForNewEmit("hello", 1);

    expect(hello.args[0]).toEqual({ token: "tok-2" });
    expect(
      currentSocket.emits.filter((entry) => entry.event === "call"),
    ).toHaveLength(0);

    (hello.args[1] as (response: any) => void)({ userId: "u-2" });
    const call = await waitForNewEmit("call", 0);
    respondToCall(call, { accepted: true });
    await expect(request).resolves.toEqual({ accepted: true });
  });

  it("does not dedupe an identical GET across reconciled owners", async () => {
    let token = "tok-1";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const firstRequest = t.get("/patient/current");
    const firstRejection = expect(firstRequest).rejects.toThrow(
      "authorization boundary",
    );
    const firstCall = await waitForNewEmit("call", 0);

    token = "tok-2";
    t.updateTokenResolver(async () => token);
    const helloCount = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    ).length;
    const secondRequest = t.get("/patient/current");
    const hello = await waitForNewEmit("hello", helloCount);
    (hello.args[1] as (response: any) => void)({ userId: "u-2" });
    const secondCall = await waitForNewEmit("call", 1);

    expect(secondCall.args[0]).not.toBe(firstCall.args[0]);
    respondToCall(secondCall, { owner: "u-2" });
    await expect(secondRequest).resolves.toEqual({ owner: "u-2" });

    respondToCall(firstCall, { owner: "u-1" });
    await firstRejection;
  });

  it("discards an already-emitted response after sign-out", async () => {
    const t = makeTransport(async () => "tok-1");
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const request = t.get("/patient/current");
    const rejection = expect(request).rejects.toThrow("session terminated");
    const call = await waitForNewEmit("call", 0);
    const requestId = call.args[0] as string;
    expect(currentSocket._handlerCount(requestId)).toBe(1);
    const helloCount = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    ).length;

    const termination = t.terminateSession();
    const signOutHello = await waitForNewEmit("hello", helloCount);
    (signOutHello.args[1] as (response: any) => void)({ userId: null });
    await termination;
    await rejection;

    expect(currentSocket._handlerCount(requestId)).toBe(0);
    respondToCall(call, { owner: "u-1" });
  });

  it("rejects a pre-send RPC when authorization changes during reconnect", async () => {
    let token = "tok-1";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");
    currentSocket.disconnect();

    const callCount = currentSocket.emits.filter(
      (entry) => entry.event === "call",
    ).length;
    const request = t.get("/patient/current");
    const rejection = expect(request).rejects.toThrow();
    await waitForNewEmit("hello", 1);

    token = "tok-2";
    t.updateTokenResolver(async () => token);
    await rejection;

    expect(
      currentSocket.emits.filter((entry) => entry.event === "call"),
    ).toHaveLength(callCount);
  });

  it("promptly cancels a disconnected RPC wait at an auth boundary", async () => {
    const t = makeTransport(async () => "tok-1");
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");
    currentSocket.disconnect();
    currentSocket.connectOnCall = false;

    const request = t.get("/patient/current");
    const rejection = expect(request).rejects.toThrow(
      "connection wait cancelled by an authorization boundary",
    );
    await vi.waitFor(() => {
      expect(currentSocket._handlerCount("connect")).toBeGreaterThan(1);
    });

    t.updateTokenResolver(async () => "tok-2");
    await rejection;
    expect(
      currentSocket.emits.filter((entry) => entry.event === "call"),
    ).toHaveLength(0);
  });

  it("fails raw sends closed until a replaced resolver is reconciled", async () => {
    let token = "tok-1";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    t.send("clinical:event", { owner: "u-1" });
    const initialEventCount = currentSocket.emits.filter(
      (entry) => entry.event === "clinical:event",
    ).length;
    expect(initialEventCount).toBe(1);

    token = "tok-2";
    t.updateTokenResolver(async () => token);
    expect(() => t.send("clinical:event", { owner: "u-2" })).toThrow(
      "reconciled session",
    );
    expect(
      currentSocket.emits.filter((entry) => entry.event === "clinical:event"),
    ).toHaveLength(initialEventCount);

    const helloCount = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    ).length;
    const refresh = t.refreshSession();
    const hello = await waitForNewEmit("hello", helloCount);
    (hello.args[1] as (response: any) => void)({ userId: "u-2" });
    await refresh;

    t.send("clinical:event", { owner: "u-2" });
    expect(
      currentSocket.emits.filter((entry) => entry.event === "clinical:event"),
    ).toHaveLength(initialEventCount + 1);
  });

  it("releases and fences raw outbound acknowledgements at an auth boundary", async () => {
    const t = makeTransport(async () => "tok-1");
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const acknowledgement = vi.fn();
    t.send(
      "clinical:request",
      { owner: "u-1", note: "prior-owner-phi" },
      acknowledgement,
    );
    const emitted = currentSocket.emits.find(
      (entry) => entry.event === "clinical:request",
    )!;
    const guardedAcknowledgement = emitted.args.at(-1);
    expect((t as any).pendingEventAcknowledgements.size).toBe(1);

    t.updateTokenResolver(async () => "tok-2");
    expect((t as any).pendingEventAcknowledgements.size).toBe(0);
    guardedAcknowledgement({ result: "prior-owner-phi" });
    expect(acknowledgement).not.toHaveBeenCalled();
  });

  it("releases raw outbound acknowledgement closures on disconnect", async () => {
    const t = makeTransport(async () => "tok-1");
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const acknowledgement = vi.fn();
    t.send("clinical:request", { owner: "u-1" }, acknowledgement);
    const emitted = currentSocket.emits.find(
      (entry) => entry.event === "clinical:request",
    )!;
    const guardedAcknowledgement = emitted.args.at(-1);
    expect((t as any).pendingEventAcknowledgements.size).toBe(1);

    t.disconnect();
    expect((t as any).pendingEventAcknowledgements.size).toBe(0);
    guardedAcknowledgement({ result: "prior-owner-phi" });
    expect(acknowledgement).not.toHaveBeenCalled();
  });

  it("drops raw subscription events during and after an owner transition until resubscribed", async () => {
    let token = "tok-1";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const handler = vi.fn();
    t.subscribe("clinical:event", handler);
    expect(currentSocket._handlerCount("clinical:event")).toBe(1);
    currentSocket._fire("clinical:event", { owner: "u-1" });
    expect(handler).toHaveBeenCalledTimes(1);

    token = "tok-2";
    t.updateTokenResolver(async () => token);
    expect(currentSocket._handlerCount("clinical:event")).toBe(0);
    expect((t as any).subscriptions.size).toBe(0);
    currentSocket._fire("clinical:event", { owner: "u-1-late" });
    expect(handler).toHaveBeenCalledTimes(1);

    const helloCount = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    ).length;
    const refresh = t.refreshSession();
    const hello = await waitForNewEmit("hello", helloCount);
    (hello.args[1] as (response: any) => void)({ userId: "u-2" });
    await refresh;

    currentSocket._fire("clinical:event", { owner: "u-2" });
    expect(handler).toHaveBeenCalledTimes(1);

    t.subscribe("clinical:event", handler);
    currentSocket._fire("clinical:event", { owner: "u-2" });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith({ owner: "u-2" });
  });

  it("replaces duplicate raw registrations without orphaning a PHI-retaining wrapper", async () => {
    const t = makeTransport(async () => "tok-1");
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const handler = vi.fn();
    const disposeFirst = t.subscribe("clinical:event", handler);
    const disposeSecond = t.subscribe("clinical:event", handler);
    expect(currentSocket._handlerCount("clinical:event")).toBe(1);
    expect((t as any).subscriptions.get("clinical:event").size).toBe(1);

    // The replaced registration's disposer must not remove the active wrapper.
    disposeFirst();
    expect(currentSocket._handlerCount("clinical:event")).toBe(1);
    currentSocket._fire("clinical:event", { owner: "u-1" });
    expect(handler).toHaveBeenCalledOnce();

    t.updateTokenResolver(async () => "tok-2");
    expect(currentSocket._handlerCount("clinical:event")).toBe(0);
    expect((t as any).subscriptions.size).toBe(0);

    // A late disposer from the purged registration is harmless and idempotent.
    disposeSecond();
    disposeSecond();
    expect(currentSocket._handlerCount("clinical:event")).toBe(0);
  });

  it("unsubscribe without a handler preserves transport-owned lifecycle listeners", async () => {
    const t = makeTransport(async () => "tok-1");
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const consumerConnect = vi.fn();
    t.subscribe("connect", consumerConnect);
    expect(currentSocket._handlerCount("connect")).toBe(2);

    t.unsubscribe("connect");
    expect(currentSocket._handlerCount("connect")).toBe(1);
    expect((t as any).subscriptions.has("connect")).toBe(false);

    currentSocket.disconnect();
    currentSocket.connect();
    const reconnectHello = await waitForNewEmit("hello", 1);
    expect(reconnectHello.args[0]).toEqual({ token: "tok-1" });
    expect(consumerConnect).not.toHaveBeenCalled();
  });

  it("retains raw subscriptions after a same-owner reconnect", async () => {
    const t = makeTransport(async () => "tok-1");
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const handler = vi.fn();
    const onResync = vi.fn();
    t.on("resync-required", onResync);
    t.subscribe("clinical:event", handler);
    currentSocket.disconnect();
    currentSocket.connect();
    const reconnectHello = await waitForNewEmit("hello", 1);
    (reconnectHello.args[1] as (response: any) => void)({ userId: "u-1" });
    await vi.waitFor(() => {
      expect(onResync).toHaveBeenCalledOnce();
    });

    currentSocket._fire("clinical:event", { owner: "u-1" });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ owner: "u-1" });
    expect(currentSocket._handlerCount("clinical:event")).toBe(1);
  });

  it("releases raw subscriptions when reconnect discovers a different owner", async () => {
    let token = "tok-1";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const priorOwnerHandler = vi.fn();
    t.subscribe("clinical:event", priorOwnerHandler);
    expect(currentSocket._handlerCount("clinical:event")).toBe(1);

    currentSocket.disconnect();
    token = "tok-2";
    currentSocket.connect();
    const reconnectHello = await waitForNewEmit("hello", 1);
    (reconnectHello.args[1] as (response: any) => void)({ userId: "u-2" });
    await vi.waitFor(() => {
      expect(t.session.state.userId).toBe("u-2");
    });

    expect(currentSocket._handlerCount("clinical:event")).toBe(0);
    expect((t as any).subscriptions.size).toBe(0);
    currentSocket._fire("clinical:event", { owner: "u-2" });
    expect(priorOwnerHandler).not.toHaveBeenCalled();
  });

  it("requires resubscription after a same-user token boundary", async () => {
    let token = "tok-1";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const handler = vi.fn();
    t.subscribe("clinical:event", handler);
    token = "tok-1-rotated";
    t.updateTokenResolver(async () => token);
    const helloCount = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    ).length;
    const refresh = t.refreshSession();
    const hello = await waitForNewEmit("hello", helloCount);
    (hello.args[1] as (response: any) => void)({ userId: "u-1" });
    await refresh;

    currentSocket._fire("clinical:event", { scope: "new-token" });
    expect(handler).not.toHaveBeenCalled();

    t.subscribe("clinical:event", handler);
    currentSocket._fire("clinical:event", { scope: "new-token" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("treats an explicit same-user refresh as a subscription auth boundary", async () => {
    let token = "tok-1";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const oldTokenHandler = vi.fn();
    t.subscribe("clinical:event", oldTokenHandler);
    token = "tok-1-rotated";

    const refresh = t.refreshSession();
    const rotatedHello = await waitForNewEmit("hello", 1);
    expect(rotatedHello.args[0]).toEqual({ token: "tok-1-rotated" });
    (rotatedHello.args[1] as (response: any) => void)({ userId: "u-1" });
    await refresh;

    currentSocket._fire("clinical:event", { scope: "new-token" });
    expect(oldTokenHandler).not.toHaveBeenCalled();
  });

  it("rejects a raw subscription registered re-entrantly while auth is pending", async () => {
    const t = makeTransport(async () => "tok");
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const handler = vi.fn();
    let registrationError: Error | null = null;
    const unsubscribe = t.session.subscribe(() => {
      if (t.session.state.status !== "pending") return;
      try {
        t.subscribe("clinical:event", handler);
      } catch (error) {
        registrationError = error as Error;
      }
    });

    const refresh = t.refreshSession();
    const hello = await waitForNewEmit("hello", 1);
    (hello.args[1] as (response: any) => void)({ userId: "u-2" });
    await refresh;
    currentSocket._fire("clinical:event", { owner: "u-2" });

    expect((registrationError as Error | null)?.message).toContain(
      "reconciled session",
    );
    expect(handler).not.toHaveBeenCalled();
    expect((t as any).subscriptions.size).toBe(0);
    unsubscribe();
  });

  it("does not resurrect an old-owner subscription on a later reconnect", async () => {
    let token = "tok-1";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const oldOwnerHandler = vi.fn();
    t.subscribe("clinical:event", oldOwnerHandler);

    token = "tok-2";
    t.updateTokenResolver(async () => token);
    const refresh = t.refreshSession();
    const ownerTwoHello = await waitForNewEmit("hello", 1);
    (ownerTwoHello.args[1] as (response: any) => void)({ userId: "u-2" });
    await refresh;

    currentSocket.disconnect();
    currentSocket.connect();
    const reconnectHello = await waitForNewEmit("hello", 2);
    (reconnectHello.args[1] as (response: any) => void)({ userId: "u-2" });
    await vi.waitFor(() => {
      expect(t.connection.state.status).toBe("connected");
    });

    currentSocket._fire("clinical:event", { owner: "u-2" });
    expect(oldOwnerHandler).not.toHaveBeenCalled();
  });

  it("does not resurrect a pre-token-boundary subscription on reconnect", async () => {
    let token = "tok-1";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const oldTokenHandler = vi.fn();
    t.subscribe("clinical:event", oldTokenHandler);

    token = "tok-1-rotated";
    t.updateTokenResolver(async () => token);
    const refresh = t.refreshSession();
    const rotatedHello = await waitForNewEmit("hello", 1);
    (rotatedHello.args[1] as (response: any) => void)({ userId: "u-1" });
    await refresh;

    currentSocket.disconnect();
    currentSocket.connect();
    const reconnectHello = await waitForNewEmit("hello", 2);
    (reconnectHello.args[1] as (response: any) => void)({ userId: "u-1" });

    currentSocket._fire("clinical:event", { scope: "rotated" });
    expect(oldTokenHandler).not.toHaveBeenCalled();
  });

  it("activates a subscription registered before the initial connect", async () => {
    const t = makeTransport(async () => "tok-1");
    const handler = vi.fn();
    t.subscribe("clinical:event", handler);

    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");
    currentSocket._fire("clinical:event", { owner: "u-1" });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ owner: "u-1" });
  });

  it("lets the latest refresh supersede an unacknowledged older refresh", async () => {
    let token = "tok-initial";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-initial");

    const handler = vi.fn();
    t.subscribe("clinical:event", handler);

    token = "tok-a";
    t.updateTokenResolver(async () => token);
    const initialHelloCount = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    ).length;
    const refreshA = t.refreshSession();
    const helloA = await waitForNewEmit("hello", initialHelloCount);

    token = "tok-b";
    t.updateTokenResolver(async () => token);
    const refreshB = t.refreshSession();
    const helloB = await waitForNewEmit("hello", initialHelloCount + 1);

    expect(() => t.send("clinical:event", { owner: "u-b" })).toThrow(
      "reconciled session",
    );
    expect(t.session.state.userId).toBe("u-initial");

    expect(helloB.args[0]).toEqual({ token: "tok-b" });
    (helloB.args[1] as (response: any) => void)({ userId: "u-b" });
    await refreshB;

    t.send("clinical:event", { owner: "u-b" });
    expect(
      currentSocket.emits.filter((entry) => entry.event === "clinical:event"),
    ).toHaveLength(1);
    currentSocket._fire("clinical:event", { owner: "u-b" });
    expect(handler).not.toHaveBeenCalled();

    (helloA.args[1] as (response: any) => void)({ userId: "u-a" });
    await refreshA;
    expect(t.session.state.userId).toBe("u-b");
  });

  it("does not publish readiness when a session listener starts a newer refresh", async () => {
    let token = "tok-1";
    const t = makeTransport(async () => token);
    const onResync = vi.fn();
    t.on("resync-required", onResync);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");
    expect(onResync).toHaveBeenCalledOnce();

    let listenerRefresh: Promise<{ userId: string | null }> | null = null;
    const unsubscribe = t.session.subscribe(() => {
      if (t.session.state.userId === "u-2" && listenerRefresh === null) {
        token = "tok-3";
        listenerRefresh = t.refreshSession();
      }
    });

    token = "tok-2";
    const firstRefresh = t.refreshSession();
    const firstHello = await waitForNewEmit("hello", 1);
    (firstHello.args[1] as (response: any) => void)({ userId: "u-2" });
    const listenerHello = await waitForNewEmit("hello", 2);

    expect(onResync).toHaveBeenCalledOnce();
    expect(() => t.send("clinical:event", { owner: "u-2" })).toThrow(
      "reconciled session",
    );

    (listenerHello.args[1] as (response: any) => void)({ userId: "u-3" });
    await firstRefresh;
    await listenerRefresh;
    unsubscribe();

    expect(t.session.state.userId).toBe("u-3");
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it("holds a re-entrant pending-session RPC until the replacement hello resolves", async () => {
    const t = makeTransport(async () => "tok");
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    let request: Promise<unknown> | null = null;
    const unsubscribe = t.session.subscribe(() => {
      if (t.session.state.status === "pending" && request === null) {
        request = t.get("/patient/current");
      }
    });
    const callCount = currentSocket.emits.filter(
      (entry) => entry.event === "call",
    ).length;
    const refresh = t.refreshSession();
    const hello = await waitForNewEmit("hello", 1);

    await Promise.resolve();
    await Promise.resolve();
    expect(
      currentSocket.emits.filter((entry) => entry.event === "call"),
    ).toHaveLength(callCount);

    (hello.args[1] as (response: any) => void)({ userId: "u-1" });
    await refresh;
    const call = await waitForNewEmit("call", callCount);
    respondToCall(call, { owner: "u-1" });
    await expect(request).resolves.toEqual({ owner: "u-1" });
    unsubscribe();
  });

  it("supersedes a deferred old resolver as soon as the resolver changes", async () => {
    let resolveOldToken: (token: string) => void = () => undefined;
    let resolver = async (): Promise<string | null> => "tok-1";
    const t = makeTransport(() => resolver());
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const oldOwnerHandler = vi.fn();
    t.subscribe("clinical:event", oldOwnerHandler);
    currentSocket.disconnect();
    resolver = () =>
      new Promise<string>((resolve) => {
        resolveOldToken = resolve;
      });
    currentSocket.connect();
    await vi.waitFor(() => {
      expect(t.connection.state.status).toBe("connected");
    });

    t.updateTokenResolver(async () => "tok-2");
    currentSocket._fire("clinical:event", { owner: "u-1" });
    expect(oldOwnerHandler).not.toHaveBeenCalled();

    const refresh = t.refreshSession();
    const newOwnerHello = await waitForNewEmit("hello", 1);
    expect(newOwnerHello.args[0]).toEqual({ token: "tok-2" });
    (newOwnerHello.args[1] as (response: any) => void)({ userId: "u-2" });
    await refresh;

    resolveOldToken("tok-1-late");
    await Promise.resolve();
    expect(
      currentSocket.emits.filter((entry) => entry.event === "hello"),
    ).toHaveLength(2);
    expect(t.session.state.userId).toBe("u-2");
  });

  it("terminateSession() locks the session machine", async () => {
    const t = makeTransport(async () => "tok");
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");
    const acknowledgement = vi.fn();
    t.send("clinical:request", { owner: "u-1" }, acknowledgement);
    const emitted = currentSocket.emits.find(
      (entry) => entry.event === "clinical:request",
    )!;
    const guardedAcknowledgement = emitted.args.at(-1);
    expect((t as any).pendingEventAcknowledgements.size).toBe(1);

    // The terminate path emits a final hello to clear the socket
    // session server-side. Ack it so the await resolves.
    const helloCount = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    ).length;
    const promise = t.terminateSession();
    expect((t as any).pendingEventAcknowledgements.size).toBe(0);
    guardedAcknowledgement({ result: "prior-owner-phi" });
    expect(acknowledgement).not.toHaveBeenCalled();
    const helloAfter = await waitForNewEmit("hello", helloCount);
    const cb = helloAfter.args[1] as (resp: any) => void;
    cb({ userId: null });
    await promise;

    expect(t.session.state.status).toBe("terminated");
  });

  it("settles termination when the socket disconnects before the null hello ack", async () => {
    const t = makeTransport(async () => "tok");
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const termination = t.terminateSession();
    await waitForNewEmit("hello", 1);
    currentSocket.disconnect();

    await expect(termination).resolves.toBeUndefined();
    expect(t.session.state.status).toBe("terminated");
  });

  it("reconnects after a prior hello ack is lost", async () => {
    const t = makeTransport(async () => "tok");
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const refresh = t.refreshSession();
    const lostHello = await waitForNewEmit("hello", 1);
    currentSocket.disconnect();
    const reconnectHello = await waitForNewEmit("hello", 2);
    expect(t.session.state.userId).toBe("u-1");
    expect(() => t.send("clinical:event", { owner: "u-1" })).toThrow(
      "reconciled session",
    );
    (reconnectHello.args[1] as (response: any) => void)({ userId: "u-1" });
    await expect(refresh).resolves.toEqual({ userId: "u-1" });

    (lostHello.args[1] as (response: any) => void)({ userId: "stale-user" });
    await Promise.resolve();
    expect(t.session.state.userId).toBe("u-1");
  });

  it("refreshSession() after termination revives the session (sign-out → sign-in flow)", async () => {
    let token: string | null = "tok-1";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");
    expect(t.session.state.status).toBe("authenticated");

    // Sign out — terminates the machine.
    token = null;
    const signOutHelloCount = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    ).length;
    const termPromise = t.terminateSession();
    const helloOut = await waitForNewEmit("hello", signOutHelloCount);
    (helloOut.args[1] as (r: any) => void)({ userId: null });
    await termPromise;
    expect(t.session.state.status).toBe("terminated");

    // Sign back in — same client, new token. Without revival, the
    // session machine would stay "terminated" and resolve(userId)
    // would no-op, leaving consumers stuck on the sign-in gate.
    token = "tok-2";
    const signInHelloCount = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    ).length;
    const refreshPromise = t.refreshSession();
    const signInHello = await waitForNewEmit("hello", signInHelloCount);
    (signInHello.args[1] as (response: any) => void)({ userId: "u-2" });
    const result = await refreshPromise;

    expect(result).toEqual({ userId: "u-2" });
    expect(t.session.state.status).toBe("authenticated");
    expect(t.session.state.userId).toBe("u-2");
  });

  it("reconnects anonymously after termination without consulting the old resolver", async () => {
    const getToken = vi.fn(async () => "tok-1");
    const t = makeTransport(getToken);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    currentSocket.disconnect();
    await t.terminateSession();
    expect(t.session.state.status).toBe("terminated");
    getToken.mockClear();

    const helloCount = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    ).length;
    currentSocket.connect();
    const reconnectHello = await waitForNewEmit("hello", helloCount);

    expect(reconnectHello.args[0]).toEqual({ token: null });
    expect(getToken).not.toHaveBeenCalled();
    (reconnectHello.args[1] as (response: any) => void)({ userId: null });
    await vi.waitFor(() => {
      expect(t.session.state.status).toBe("terminated");
    });
  });

  it("invalidates an in-flight token resolver before sign-out", async () => {
    let resolveRefreshToken: (token: string) => void = () => undefined;
    let refreshResolverStarted = false;
    let getToken = async (): Promise<string | null> => "tok-1";
    const t = makeTransport(() => getToken());
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    getToken = () =>
      new Promise<string>((resolve) => {
        refreshResolverStarted = true;
        resolveRefreshToken = resolve;
      });
    const initialHelloCount = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    ).length;
    const refresh = t.refreshSession();
    const refreshRejection = expect(refresh).rejects.toThrow(
      "terminated during reconciliation",
    );
    await vi.waitFor(() => {
      expect(refreshResolverStarted).toBe(true);
    });

    const termination = t.terminateSession();
    const terminateHello = await waitForNewEmit("hello", initialHelloCount);
    expect(terminateHello.args[0]).toEqual({ token: null });
    (terminateHello.args[1] as (response: any) => void)({ userId: null });
    await termination;

    resolveRefreshToken("tok-2");
    await refreshRejection;

    expect(t.session.state.status).toBe("terminated");
    const hellos = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    );
    expect(hellos).toHaveLength(initialHelloCount + 1);
    expect(hellos.at(-1)?.args[0]).toEqual({ token: null });
  });

  it("rejects an RPC awaiting reconciliation when sign-out terminates its session", async () => {
    let resolveNextToken: (token: string) => void = () => undefined;
    let resolverStarted = false;
    const t = makeTransport(async () => "tok-1");
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    t.updateTokenResolver(
      () =>
        new Promise<string>((resolve) => {
          resolverStarted = true;
          resolveNextToken = resolve;
        }),
    );
    const initialHelloCount = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    ).length;
    const request = t.post("/patient/update", { value: "stale" });
    const requestRejection = expect(request).rejects.toThrow();
    await vi.waitFor(() => {
      expect(resolverStarted).toBe(true);
    });

    const termination = t.terminateSession();
    const signOutHello = await waitForNewEmit("hello", initialHelloCount);
    expect(signOutHello.args[0]).toEqual({ token: null });
    (signOutHello.args[1] as (response: any) => void)({ userId: null });
    await termination;

    resolveNextToken("tok-1-stale");
    await requestRejection;

    expect(t.session.state.status).toBe("terminated");
    expect(
      currentSocket.emits.filter((entry) => entry.event === "call"),
    ).toHaveLength(0);
    expect(
      currentSocket.emits.filter((entry) => entry.event === "hello"),
    ).toHaveLength(initialHelloCount + 1);
  });

  it("resync RPC sends a queries envelope and resolves with the results", async () => {
    const t = makeTransport(async () => "tok");
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

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

    const resyncEmit = await waitForNewEmit("resync", 0);
    expect(resyncEmit.args[0]).toEqual({
      queries: [{ key: "post:u-1:[]", modelType: "post", steps: [] }],
    });

    const cb = resyncEmit.args[1] as (resp: any) => void;
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

  it("discards an in-flight resync response after an owner transition", async () => {
    let token = "tok-1";
    const t = makeTransport(async () => token);
    currentSocket.connect();
    await waitForNewEmit("hello", 0);
    await ackHello("u-1");

    const resync = t.resync([
      {
        key: "post:u-1:[]",
        modelType: "post",
        steps: [],
      },
    ]);
    const rejection = expect(resync).rejects.toThrow("authorization boundary");
    const resyncEmit = await waitForNewEmit("resync", 0);

    token = "tok-2";
    t.updateTokenResolver(async () => token);
    await rejection;
    const helloCount = currentSocket.emits.filter(
      (entry) => entry.event === "hello",
    ).length;
    const refresh = t.refreshSession();
    const hello = await waitForNewEmit("hello", helloCount);
    (hello.args[1] as (response: any) => void)({ userId: "u-2" });
    await refresh;

    (resyncEmit.args[1] as (response: any) => void)({
      success: true,
      results: [
        {
          key: "post:u-1:[]",
          hash: "old-user-hash",
          items: [{ owner: "u-1" }],
          totalCount: 1,
        },
      ],
    });
  });
});
