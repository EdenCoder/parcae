/**
 * SocketTransport watchdog — recovery for a silently dead socket.
 *
 * The OS can suppress a device's network stack so the socket.io engine
 * wedges in `connecting` (or connects but hello never acks) with no
 * error event. The watchdog tears the engine down and rebuilds it with
 * backoff. These tests drive it with fake timers against the same
 * FakeSocket harness as socket-transport.test.ts.
 */
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
const sockets: FakeSocket[] = [];

vi.mock("socket.io-client", () => ({
  default: vi.fn((_url: string, _config: any) => {
    currentSocket = new FakeSocket();
    sockets.push(currentSocket);
    return currentSocket;
  }),
}));

// eslint-disable-next-line import/first
import { SocketTransport, _resetSockets } from "../transports/socket";

function makeTransport(getToken: () => Promise<string | null>) {
  _resetSockets();
  return new SocketTransport({ url: "http://localhost:0", getToken });
}

/** Ack the most recent hello emit and flush the handshake microtasks. */
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

function recoverEvents(transport: SocketTransport): any[] {
  const events: any[] = [];
  transport.on("watchdog:recover", (e: any) => events.push(e));
  return events;
}

describe("SocketTransport — watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetSockets();
    sockets.length = 0;
  });
  afterEach(() => {
    _resetSockets();
    vi.useRealTimers();
  });

  it("recovers a socket stuck connecting after staleMs", async () => {
    const transport = makeTransport(async () => null);
    currentSocket.connectOnCall = false;
    const events = recoverEvents(transport);

    await vi.advanceTimersByTimeAsync(7_900);
    expect(events).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("connect-stalled");
    expect(events[0].attempt).toBe(1);
    expect(events[0].diagnostics.connectionStatus).toBeDefined();
    expect(currentSocket.connectCalls).toBeGreaterThanOrEqual(1);
  });

  it("recovers a connected socket whose hello never acks", async () => {
    const transport = makeTransport(async () => "tok");
    const events = recoverEvents(transport);
    currentSocket.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      currentSocket.emits.filter((e) => e.event === "hello"),
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(8_100);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("hello-stalled");
  });

  it("backs off exponentially and resets on health", async () => {
    const transport = makeTransport(async () => "tok");
    currentSocket.connectOnCall = false;
    const events = recoverEvents(transport);

    await vi.advanceTimersByTimeAsync(8_100);
    expect(events).toHaveLength(1);

    // Second recovery waits 16s (8s * 2^1) from the first, not 8s.
    await vi.advanceTimersByTimeAsync(15_800);
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(events).toHaveLength(2);

    // Health resets the backoff counter.
    currentSocket.connectOnCall = true;
    currentSocket.connect();
    await vi.advanceTimersByTimeAsync(0);
    await ackHello("u1");
    expect(transport.diagnostics().recoveryAttempts).toBe(0);
    expect(transport.diagnostics().sessionStatus).toBe("authenticated");
  });

  it("stays idle after terminateSession", async () => {
    const transport = makeTransport(async () => "tok");
    currentSocket.connectOnCall = false;
    const events = recoverEvents(transport);
    await transport.terminateSession();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(events).toHaveLength(0);
  });

  it("stays idle after manual disconnect and re-arms on reconnect", async () => {
    const transport = makeTransport(async () => "tok");
    currentSocket.connectOnCall = false;
    const events = recoverEvents(transport);
    transport.disconnect();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(events).toHaveLength(0);

    await transport.reconnect();
    await vi.advanceTimersByTimeAsync(8_100);
    expect(events).toHaveLength(1);
  });

  it("kick() recovers immediately after the floor and no-ops when healthy", async () => {
    const transport = makeTransport(async () => "tok");
    currentSocket.connectOnCall = false;
    const events = recoverEvents(transport);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(events).toHaveLength(0);
    transport.kick();
    expect(events).toHaveLength(1);

    currentSocket.connectOnCall = true;
    currentSocket.connect();
    await vi.advanceTimersByTimeAsync(0);
    await ackHello("u1");
    transport.kick();
    expect(events).toHaveLength(1);
  });

  it("kick() inside the floor does not recover early", async () => {
    const transport = makeTransport(async () => "tok");
    currentSocket.connectOnCall = false;
    const events = recoverEvents(transport);

    await vi.advanceTimersByTimeAsync(1_000);
    transport.kick();
    expect(events).toHaveLength(0);
  });

  it("setActive(false) suspends; setActive(true) measures from re-activation", async () => {
    const transport = makeTransport(async () => "tok");
    currentSocket.connectOnCall = false;
    const events = recoverEvents(transport);
    transport.setActive(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(0);

    transport.setActive(true);
    await vi.advanceTimersByTimeAsync(7_900);
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(events).toHaveLength(1);
  });

  it("does nothing while healthy", async () => {
    const transport = makeTransport(async () => "tok");
    const events = recoverEvents(transport);
    currentSocket.connect();
    await vi.advanceTimersByTimeAsync(0);
    await ackHello("u1");

    const callsBefore = currentSocket.connectCalls;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(events).toHaveLength(0);
    expect(currentSocket.connectCalls).toBe(callsBefore);
    expect(transport.diagnostics().msSinceHelloAck).not.toBeNull();
  });
});
