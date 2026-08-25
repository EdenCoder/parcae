/**
 * SocketTransport watchdog: recovery for a connected socket whose RPCs
 * starve.
 *
 * A half-dead network path can pass small frames (hello ack, pings) while
 * dropping the larger RPC response frames. The socket looks connected and
 * the session authenticated, yet every find sits unanswered until its
 * 120s timeout. The watchdog must treat "in-flight RPCs, none answered
 * for the stale window" as transport un-health and rebuild the engine,
 * while never firing when responses are still flowing (a slow server is
 * not a dead wire). Uses the same FakeSocket harness as
 * socket-watchdog.test.ts.
 */
import { compress } from "compress-json";
import pako from "pako";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeSocket {
  connected = false;
  connectOnCall = true;
  connectCalls = 0;
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
    this.connectCalls++;
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

function makeTransport(getToken: () => Promise<string | null>) {
  return new SocketTransport({ url: "http://localhost:0", getToken });
}

async function ackHello(userId: string | null): Promise<void> {
  const hello = [...currentSocket.emits]
    .reverse()
    .find((e) => e.event === "hello");
  if (!hello) throw new Error("no hello emit found");
  const cb = hello.args[1] as (resp: any) => void;
  cb({ userId });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

/** Find the nth "call" emit and answer it over the wire shape the
 * transport expects (gzip of compress-json). */
function answerCall(index: number, result: unknown): void {
  const calls = currentSocket.emits.filter((e) => e.event === "call");
  const call = calls[index];
  if (!call) throw new Error(`no call emit at index ${index}`);
  const requestId = call.args[0] as string;
  const payload = pako.gzip(
    JSON.stringify(compress({ result, success: true })),
  );
  currentSocket._fire(requestId, payload);
}

function recoverEvents(transport: SocketTransport): any[] {
  const events: any[] = [];
  transport.on("watchdog:recover", (e: any) => events.push(e));
  return events;
}

async function connectedAuthedTransport(): Promise<SocketTransport> {
  const transport = makeTransport(async () => "tok");
  currentSocket.connect();
  await vi.advanceTimersByTimeAsync(0);
  await ackHello("u1");
  return transport;
}

describe("SocketTransport — RPC-stall watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rebuilds the engine when in-flight RPCs get no answer for staleMs", async () => {
    const transport = await connectedAuthedTransport();
    const events = recoverEvents(transport);

    const pending = transport.get("/nudges");
    const rejection = expect(pending).rejects.toThrow("Disconnected");
    await vi.advanceTimersByTimeAsync(0);
    expect(
      currentSocket.emits.filter((e) => e.event === "call"),
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(7_800);
    expect(events).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(400);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("rpc-stalled");
    await rejection;
  });

  it("does not rebuild while responses are still flowing", async () => {
    const transport = await connectedAuthedTransport();
    const events = recoverEvents(transport);

    const fast = transport.get("/fast");
    const slow = transport.get("/slow");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_000);
    answerCall(0, []);
    await expect(fast).resolves.toEqual([]);

    // The slow RPC alone must not trigger a rebuild: a response arrived
    // after it was dispatched, so the wire is proven alive.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events).toHaveLength(0);

    answerCall(1, ["late"]);
    await expect(slow).resolves.toEqual(["late"]);
  });

  it("rebuilds when the wire dies after earlier responses", async () => {
    const transport = await connectedAuthedTransport();
    const events = recoverEvents(transport);

    const first = transport.get("/first");
    await vi.advanceTimersByTimeAsync(0);
    answerCall(0, []);
    await expect(first).resolves.toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    const starved = transport.get("/starved");
    const rejection = expect(starved).rejects.toThrow("Disconnected");
    await vi.advanceTimersByTimeAsync(8_400);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("rpc-stalled");
    await rejection;
  });

  it("emits rpc:recovered when responses resume after a stall recovery", async () => {
    const transport = await connectedAuthedTransport();
    const recovered: unknown[] = [];
    transport.on("rpc:recovered", () => recovered.push(true));

    const starved = transport.get("/nudges");
    const rejection = expect(starved).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(8_400);
    await rejection;
    expect(recovered).toHaveLength(0);

    // The rebuild reconnected the fake socket; complete the new hello,
    // then answer the next RPC: that first answered response signals
    // recovery, exactly once.
    await ackHello("u1");
    const next = transport.get("/nudges");
    await vi.advanceTimersByTimeAsync(0);
    answerCall(1, []);
    await expect(next).resolves.toEqual([]);
    expect(recovered).toHaveLength(1);

    const another = transport.get("/nudges");
    await vi.advanceTimersByTimeAsync(0);
    answerCall(2, []);
    await expect(another).resolves.toEqual([]);
    expect(recovered).toHaveLength(1);
  });

  it("reports pending RPCs in diagnostics", async () => {
    const transport = await connectedAuthedTransport();
    expect(transport.diagnostics().pendingCallCount).toBe(0);
    expect(transport.diagnostics().msSinceOldestPendingCall).toBeNull();

    const pending = transport.get("/nudges");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(transport.diagnostics().pendingCallCount).toBe(1);
    expect(
      transport.diagnostics().msSinceOldestPendingCall,
    ).toBeGreaterThanOrEqual(2_000);

    answerCall(0, []);
    await expect(pending).resolves.toEqual([]);
    expect(transport.diagnostics().pendingCallCount).toBe(0);
    expect(transport.diagnostics().msSinceOldestPendingCall).toBeNull();
  });

  it("never tears down a lone call that declared its own timeout", async () => {
    const transport = await connectedAuthedTransport();
    const events = recoverEvents(transport);

    // The caller budgeted 90s for server-side work (LLM generation,
    // imports); the stall clock must not second-guess it at 8s.
    const pending = transport.post("/consult-reports/generate", {}, {
      timeout: 90_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(0);

    answerCall(0, { ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
    expect(events).toHaveLength(0);
  });

  it("an exempt call still fails at its own declared timeout", async () => {
    const transport = await connectedAuthedTransport();
    const pending = transport.post("/slow", {}, { timeout: 20_000 });
    const rejection = expect(pending).rejects.toThrow("RPC timeout");
    await vi.advanceTimersByTimeAsync(20_100);
    await rejection;
  });

  it("recovers a starved RPC that other traffic was masking", async () => {
    const transport = await connectedAuthedTransport();
    const events = recoverEvents(transport);

    // The app opens a screen and fires a burst. One find never comes
    // back; the rest answer normally. `lastRpcResponseAt` then sits
    // ahead of the starved call's dispatch time forever, so the
    // "a response proves the wire" test can never fire again — the
    // starved query pulsed a skeleton until its 120s timeout, retried,
    // and pulsed again. A live wire cannot excuse an unanswered call
    // indefinitely.
    const starved = transport.get("/nutrition-sprints");
    const healthy = transport.get("/events");
    await vi.advanceTimersByTimeAsync(0);
    const rejection = expect(starved).rejects.toThrow("Disconnected");

    await vi.advanceTimersByTimeAsync(1_000);
    answerCall(1, []);
    await expect(healthy).resolves.toEqual([]);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(events).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("rpc-stalled");
    await rejection;
  });

  it("does not let the starvation floor touch a call with its own budget", async () => {
    const transport = await connectedAuthedTransport();
    const events = recoverEvents(transport);

    // Same masking shape, but the long call declared its budget. The
    // floor must read as "unanswered past any reasonable query", not
    // "unanswered past 30s" — an exempt call is never in that clock.
    const budgeted = transport.post("/nutrition/meals", {}, {
      timeout: 120_000,
    });
    const healthy = transport.get("/events");
    await vi.advanceTimersByTimeAsync(0);

    answerCall(1, []);
    await expect(healthy).resolves.toEqual([]);

    await vi.advanceTimersByTimeAsync(90_000);
    expect(events).toHaveLength(0);

    answerCall(0, { ok: true });
    await expect(budgeted).resolves.toEqual({ ok: true });
    expect(events).toHaveLength(0);
  });

  it("a subscription frame resets the stall clock for default-timeout calls", async () => {
    const transport = await connectedAuthedTransport();
    const events = recoverEvents(transport);
    transport.subscribe("query:h1", () => {});

    const pending = transport.get("/nudges");
    await vi.advanceTimersByTimeAsync(0);

    // Data frames keep arriving: the wire passes full frames, so the
    // slow RPC is a slow server, not a dead socket.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(6_000);
      currentSocket._fire("query:h1", { op: "tick" });
    }
    expect(events).toHaveLength(0);

    answerCall(0, []);
    await expect(pending).resolves.toEqual([]);
  });
});
