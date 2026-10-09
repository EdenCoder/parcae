import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => {
  const clients: any[] = [];
  let connectError: Error | null = null;
  let connectGate: Promise<void> | null = null;
  let endDuringQuery = false;
  let deliverNotify = true;
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
          client.emit('error', connectError);
          throw connectError;
        }
      }),
      isListener: false,
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.startsWith('LISTEN')) client.isListener = true;
        if (endDuringQuery) {
          endDuringQuery = false;
          client.emit('end');
        }
        // A direct endpoint fans a NOTIFY to every session listening on the
        // channel. A transaction-mode pooler accepts the statement and
        // delivers it to nobody, which `deliverNotify = false` models.
        if (sql.includes('pg_notify') && deliverNotify) {
          // Broadcast: the probe notifies from a second connection, so
          // delivery has to cross clients the way a row trigger does.
          for (const peer of clients) {
            peer.emit('notification', {
              channel: String(params?.[0]),
              payload: String(params?.[1]),
            });
          }
        }
      }),
      end: vi.fn(async () => {}),
    };
    clients.push(client);
    return client;
  });
  return {
    Client,
    clients,
    /**
     * Connections that ran LISTEN. The delivery probe opens a second,
     * short-lived connection to notify from, and no assertion about the
     * bus's own subscription should have to count it.
     */
    listeners: () => clients.filter((c) => c.isListener),
    reset() {
      clients.length = 0;
      connectError = null;
      connectGate = null;
      endDuringQuery = false;
      deliverNotify = true;
      Client.mockClear();
    },
    swallowNotifications() {
      deliverNotify = false;
    },
    failConnect(error: Error | null) {
      connectError = error;
    },
    deferConnect() {
      let release!: () => void;
      connectGate = new Promise<void>((resolve) => {
        release = () => {
          connectGate = null;
          resolve();
        };
      });
      return release;
    },
    endDuringListen() {
      endDuringQuery = true;
    },
  };
});

vi.mock('pg', () => ({ Client: pg.Client }));

import {
  ChangeBus,
  PARCAE_CHANNEL,
  type Change,
} from '../services/change-bus';

describe('ChangeBus', () => {
  beforeEach(() => {
    pg.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The failure this suite exists for. A transaction-mode pooler accepts
  // LISTEN, reports success, and returns the server connection to the pool,
  // so nothing an application does afterwards is wrong and nothing errors:
  // triggers fire, notifications reach nobody, and every realtime surface is
  // quiet while every health check is green. Freia ran that way in
  // production from the ECS cutover until someone noticed a note needed a
  // page refresh.
  it('refuses a connection whose LISTEN cannot receive', async () => {
    pg.swallowNotifications();
    const bus = new ChangeBus({
      url: 'postgres://unused',
      deliveryProbeTimeoutMs: 1000,
    });

    const started = bus.start();
    const settled = started.then(
      () => null,
      (err: Error) => err,
    );
    await vi.advanceTimersByTimeAsync(1000);

    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/did not arrive/);
    await bus.stop();
  });

  it('proves delivery with a probe listeners never see', async () => {
    const changes: Change[] = [];
    const bus = new ChangeBus({ url: 'postgres://unused' });
    bus.on((change) => changes.push(change));

    await bus.start();

    // Issued from a second connection on purpose: a pooler delivers a
    // session's notification to itself, so a same-connection probe passes
    // against exactly the endpoint this exists to reject.
    const notifier = pg.clients.find((c) => !c.isListener);
    expect(notifier).toBeDefined();
    expect(notifier!.query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
      PARCAE_CHANNEL,
      expect.stringContaining('__parcaeProbe'),
    ]);
    expect(changes).toEqual([]);
    await bus.stop();
  });

  // Every process on the channel receives every other process's probe. A
  // probe is never a model change, so it is swallowed whoever sent it.
  it('swallows another process probe without dispatching it', async () => {
    const changes: Change[] = [];
    const bus = new ChangeBus({ url: 'postgres://unused' });
    bus.on((change) => changes.push(change));
    await bus.start();

    pg.clients[0]!.emit('notification', {
      channel: PARCAE_CHANNEL,
      payload: JSON.stringify({ __parcaeProbe: 'someone-elses-nonce' }),
    });

    expect(changes).toEqual([]);
    await bus.stop();
  });

  it('listens on Postgres and dispatches compact row changes', async () => {
    const changes: Change[] = [];
    const bus = new ChangeBus({ url: 'postgres://unused' });
    bus.on((change) => changes.push(change));

    await bus.start();
    expect(pg.clients[0]!.query).toHaveBeenCalledWith(
      `LISTEN ${PARCAE_CHANNEL}`,
    );
    pg.clients[0]!.emit('notification', {
      channel: PARCAE_CHANNEL,
      payload: JSON.stringify({
        table: 'posts',
        op: 'update',
        id: 'p1',
        changedFields: ['title', 'updatedAt', 'title'],
      }),
    });

    expect(changes).toEqual([
      {
        table: 'posts',
        op: 'update',
        id: 'p1',
        changedFields: ['title', 'updatedAt'],
      },
    ]);
    await bus.stop();
  });

  it('accepts old trigger payloads as field-unknown changes', async () => {
    const changes: Change[] = [];
    const bus = new ChangeBus({ url: 'postgres://unused' });
    bus.on((change) => changes.push(change));
    await bus.start();

    pg.clients[0]!.emit('notification', {
      channel: PARCAE_CHANNEL,
      payload: JSON.stringify({ table: 'posts', op: 'delete', id: 'p1' }),
    });

    expect(changes[0]!.changedFields).toBeNull();
    await bus.stop();
  });

  it('ignores malformed notifications and isolates listener errors', async () => {
    const received: Change[] = [];
    const bus = new ChangeBus({ url: 'postgres://unused' });
    bus.on(() => {
      throw new Error('broken listener');
    });
    bus.on((change) => received.push(change));
    await bus.start();

    pg.clients[0]!.emit('notification', {
      channel: PARCAE_CHANNEL,
      payload: '{bad json',
    });
    pg.clients[0]!.emit('notification', {
      channel: PARCAE_CHANNEL,
      payload: JSON.stringify({ table: 'posts', op: 'update', id: 'p1' }),
    });

    expect(received).toHaveLength(1);
    await bus.stop();
  });

  it('reconciles consumers after reconnecting', async () => {
    const bus = new ChangeBus({
      url: 'postgres://unused',
      initialReconnectDelay: 10,
    });
    const reconnected = vi.fn();
    bus.onReconnect(reconnected);
    await bus.start();

    pg.clients[0]!.emit('error', new Error('network lost'));
    await vi.advanceTimersByTimeAsync(10);

    expect(pg.listeners()).toHaveLength(2);
    expect(reconnected).toHaveBeenCalledTimes(1);
    await bus.stop();
  });

  it('reconnects when the initial client ends before LISTEN resolves', async () => {
    pg.endDuringListen();
    const bus = new ChangeBus({
      url: 'postgres://unused',
      initialReconnectDelay: 10,
    });
    const reconnected = vi.fn();
    bus.onReconnect(reconnected);

    await bus.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(pg.listeners()).toHaveLength(2);
    expect(reconnected).toHaveBeenCalledTimes(1);
    await bus.stop();
  });

  it('cleans a failed initial connection without scheduling reconnect', async () => {
    pg.failConnect(new Error('connection refused'));
    const bus = new ChangeBus({
      url: 'postgres://unused',
      initialReconnectDelay: 10,
    });

    await expect(bus.start()).rejects.toThrow('connection refused');
    expect(pg.clients[0]!.end).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    // Total connections, not listeners: this one never reached LISTEN, and
    // the point is that no replacement was dialled behind it.
    expect(pg.clients).toHaveLength(1);
  });

  it('cancels an armed reconnect when stopped', async () => {
    const bus = new ChangeBus({
      url: 'postgres://unused',
      initialReconnectDelay: 10,
    });
    await bus.start();
    pg.clients[0]!.emit('error', new Error('network lost'));

    await bus.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(pg.listeners()).toHaveLength(1);
    expect(pg.clients[0]!.end).toHaveBeenCalledTimes(1);
  });

  it('cancels and closes an in-progress startup', async () => {
    const release = pg.deferConnect();
    const bus = new ChangeBus({
      url: 'postgres://unused',
      connectTimeoutMs: 50,
    });

    const starting = bus.start();
    const failure = expect(starting).rejects.toThrow('stopped during startup');
    await Promise.resolve();
    await bus.stop();
    await failure;
    expect(pg.clients[0]!.end).toHaveBeenCalledTimes(1);
    release();
  });

  it('bounds connection setup with a finite timeout', async () => {
    pg.deferConnect();
    const bus = new ChangeBus({
      url: 'postgres://unused',
      connectTimeoutMs: 25,
    });

    const starting = bus.start();
    const failure = expect(starting).rejects.toThrow(
      'connection timed out after 25ms',
    );
    await vi.advanceTimersByTimeAsync(25);
    await failure;

    expect(pg.Client).toHaveBeenCalledWith(
      expect.objectContaining({ connectionTimeoutMillis: 25 }),
    );
    expect(pg.clients[0]!.end).toHaveBeenCalledTimes(1);
  });
});
