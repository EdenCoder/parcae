import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => {
  const clients: any[] = [];
  let connectError: Error | null = null;
  let connectGate: Promise<void> | null = null;
  const Client = vi.fn().mockImplementation(function () {
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const client = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return client;
      }),
      emit: (event: string, ...args: any[]) => {
        for (const handler of handlers.get(event) ?? []) handler(...args);
      },
      connect: vi.fn(async () => {
        if (connectGate) await connectGate;
        if (connectError) {
          client.emit("error", connectError);
          throw connectError;
        }
      }),
      query: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
    };
    clients.push(client);
    return client;
  });
  return {
    Client,
    clients,
    reset() {
      clients.length = 0;
      connectError = null;
      connectGate = null;
      Client.mockClear();
    },
    failConnect(error: Error | null) {
      connectError = error;
    },
    deferConnect() {
      let release!: () => void;
      connectGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
});

vi.mock("pg", () => ({ Client: pg.Client }));

import { ListenNotifyPoller } from "../services/listenNotifyPoller";

describe("ListenNotifyPoller lifecycle", () => {
  beforeEach(() => {
    pg.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cleans a failed initial client without scheduling reconnect", async () => {
    pg.failConnect(new Error("connection refused"));
    const poller = new ListenNotifyPoller({
      url: "postgres://unused",
      changeBus: { emit: vi.fn() } as any,
      initialReconnectDelay: 10,
    });

    await expect(poller.start()).rejects.toThrow("connection refused");
    expect(pg.clients[0]!.end).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(pg.clients).toHaveLength(1);
  });

  it("cancels an armed reconnect when stopped", async () => {
    const poller = new ListenNotifyPoller({
      url: "postgres://unused",
      changeBus: { emit: vi.fn() } as any,
      initialReconnectDelay: 10,
    });
    await poller.start();
    pg.clients[0]!.emit("error", new Error("network lost"));

    await poller.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(pg.clients).toHaveLength(1);
    expect(pg.clients[0]!.end).toHaveBeenCalledTimes(1);
  });

  it("cancels and closes an in-progress startup without waiting for connect", async () => {
    const release = pg.deferConnect();
    const poller = new ListenNotifyPoller({
      url: "postgres://unused",
      changeBus: { emit: vi.fn() } as any,
      connectTimeoutMs: 50,
    });

    const starting = poller.start();
    const startFailure = expect(starting).rejects.toThrow(
      "stopped during startup",
    );
    await Promise.resolve();
    const stopping = poller.stop();
    await stopping;
    expect(pg.clients[0]!.end).toHaveBeenCalledTimes(1);

    await startFailure;
    release();
  });

  it("cancels an in-progress reconnect and closes its stale generation", async () => {
    const poller = new ListenNotifyPoller({
      url: "postgres://unused",
      changeBus: { emit: vi.fn() } as any,
      initialReconnectDelay: 10,
      connectTimeoutMs: 50,
    });
    await poller.start();

    const release = pg.deferConnect();
    pg.clients[0]!.emit("error", new Error("network lost"));
    await vi.advanceTimersByTimeAsync(10);
    expect(pg.clients).toHaveLength(2);

    const stopping = poller.stop();

    await stopping;
    expect(pg.clients[1]!.query).not.toHaveBeenCalled();
    expect(pg.clients[1]!.end).toHaveBeenCalledTimes(1);
    release();
  });

  it("bounds a connection attempt with a finite timeout", async () => {
    pg.deferConnect();
    const poller = new ListenNotifyPoller({
      url: "postgres://unused",
      changeBus: { emit: vi.fn() } as any,
      connectTimeoutMs: 25,
    });

    const starting = poller.start();
    const failure = expect(starting).rejects.toThrow(
      "connection timed out after 25ms",
    );
    await vi.advanceTimersByTimeAsync(25);
    await failure;

    expect(pg.Client).toHaveBeenCalledWith(
      expect.objectContaining({ connectionTimeoutMillis: 25 }),
    );
    expect(pg.clients[0]!.end).toHaveBeenCalledTimes(1);
  });
});
