/**
 * Postgres-native model change bus.
 *
 * Row triggers publish compact notifications after commit. Every API process
 * owns one dedicated LISTEN connection and dispatches those changes to its
 * local subscription manager. Postgres is therefore both the write source and
 * the cross-process fan-out; Redis and adapter-side duplicate events are not
 * involved.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { log } from '../logger';
import { PARCAE_CHANGE_CHANNEL } from './change-triggers';

export const PARCAE_CHANNEL = PARCAE_CHANGE_CHANNEL;

const INITIAL_RECONNECT_DELAY = 500;
const MAX_RECONNECT_DELAY = 30_000;
const CONNECT_TIMEOUT = 10_000;
const DELIVERY_PROBE_TIMEOUT = 5_000;

/** Marks a self-addressed notification, never dispatched to listeners. */
const PROBE_KEY = '__parcaeProbe';

/**
 * A connection pooler in transaction mode accepts LISTEN, reports success,
 * and then hands the server connection back to the pool, so the session that
 * holds the subscription is not the session any later NOTIFY reaches. Nothing
 * errors: the trigger fires, the notification is delivered to nobody, and
 * every realtime surface goes quiet while looking healthy. Neon publishes a
 * direct endpoint alongside the pooled one under the same host with the
 * `-pooler` suffix removed, so a deployment that only knows its pooled URL
 * can still reach a session that keeps a LISTEN.
 */
export function directEndpointFor(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.hostname.includes('-pooler')) return null;
  parsed.hostname = parsed.hostname.replace('-pooler', '');
  return parsed.toString();
}

export type ChangeOp = 'insert' | 'update' | 'delete';

export interface Change {
  table: string;
  op: ChangeOp;
  id: string;
  /** Null means the publisher predates field-aware notifications. */
  changedFields: string[] | null;
}

export type ChangeListener = (change: Change) => void;

interface ChangeBusOptions {
  url: string;
  /**
   * Connection to hold the LISTEN on, when it differs from `url`. Defaults
   * to `url` with any pooler suffix removed, because `url` is the one every
   * deployment already sets and a pooled one cannot carry a subscription.
   */
  listenUrl?: string;
  initialReconnectDelay?: number;
  maxReconnectDelay?: number;
  connectTimeoutMs?: number;
  deliveryProbeTimeoutMs?: number;
}

export class ChangeBus {
  private url: string;
  private initialReconnectDelay: number;
  private maxReconnectDelay: number;
  private connectTimeoutMs: number;
  private listeners = new Set<ChangeListener>();
  private reconnectListeners = new Set<() => void>();
  private client: Client | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private state: 'stopped' | 'starting' | 'started' = 'stopped';
  private generation = 0;
  private connectAttempt: Promise<boolean> | null = null;
  private reconnectWork: Promise<void> | null = null;
  private cancelConnect: (() => void) | null = null;
  private closingClients = new WeakMap<Client, Promise<void>>();
  private disconnectedDuringStart = false;
  private deliveryProbeTimeoutMs: number;
  private pendingProbe: { nonce: string; settle: (ok: boolean) => void } | null =
    null;

  constructor(opts: ChangeBusOptions) {
    const listenUrl = opts.listenUrl ?? directEndpointFor(opts.url);
    if (listenUrl && listenUrl !== opts.url) {
      log.info(
        'changeBus: holding LISTEN on the direct endpoint, not the pooled one',
      );
    }
    this.url = listenUrl ?? opts.url;
    this.deliveryProbeTimeoutMs = Math.max(
      1,
      opts.deliveryProbeTimeoutMs ?? DELIVERY_PROBE_TIMEOUT,
    );
    this.initialReconnectDelay =
      opts.initialReconnectDelay ?? INITIAL_RECONNECT_DELAY;
    this.maxReconnectDelay = opts.maxReconnectDelay ?? MAX_RECONNECT_DELAY;
    this.connectTimeoutMs = Math.max(1, opts.connectTimeoutMs ?? CONNECT_TIMEOUT);
  }

  on(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Run after LISTEN is restored so consumers can reconcile missed events. */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped') {
      throw new Error(`changeBus: cannot start while ${this.state}`);
    }
    this.state = 'starting';
    this.disconnectedDuringStart = false;
    const generation = ++this.generation;
    try {
      const connected = await this._trackConnect(generation);
      if (!connected) throw new Error('changeBus: stopped during startup');
      this.state = 'started';
      if (this.disconnectedDuringStart) {
        this.disconnectedDuringStart = false;
        this._scheduleReconnect();
      }
    } catch (err) {
      this.disconnectedDuringStart = false;
      if (this.generation === generation) this.state = 'stopped';
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      if (this.generation !== generation) {
        throw new Error('changeBus: stopped during startup');
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
    this.disconnectedDuringStart = false;
    this.generation++;
    this.cancelConnect?.();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.client;
    this.client = null;
    if (client) await this._endClient(client);
    const pending: Promise<unknown>[] = [];
    if (this.connectAttempt) pending.push(this.connectAttempt);
    if (this.reconnectWork) pending.push(this.reconnectWork);
    if (pending.length > 0) await Promise.allSettled(pending);
    this.listeners.clear();
    this.reconnectListeners.clear();
  }

  private async _connect(generation: number): Promise<boolean> {
    const client = new Client({
      connectionString: this.url,
      connectionTimeoutMillis: this.connectTimeoutMs,
    });
    this.client = client;

    client.on('error', (err: Error) => {
      log.warn(`changeBus: client error: ${err.message}`);
      if (this._isCurrent(generation) && this.client === client) {
        this._handleDisconnect();
      }
    });
    client.on('end', () => {
      if (this._isCurrent(generation) && this.client === client) {
        this._handleDisconnect();
      }
    });
    client.on('notification', (message) => {
      if (message.channel !== PARCAE_CHANNEL) return;
      if (this._consumeProbe(message.payload)) return;
      const change = this._parse(message.payload);
      if (!change) return;
      for (const listener of this.listeners) {
        try {
          listener(change);
        } catch (err) {
          log.warn(`changeBus: listener threw: ${String(err)}`);
        }
      }
    });

    if (!this._isCurrent(generation)) {
      if (this.client === client) this.client = null;
      await this._endClient(client);
      return false;
    }

    let abandoned = false;
    try {
      const setup = (async () => {
        await client.connect();
        if (abandoned || !this._isCurrent(generation)) return;
        await client.query(`LISTEN ${PARCAE_CHANNEL}`);
      })();
      await this._awaitConnect(setup);
      if (this._isCurrent(generation) && !abandoned) {
        await this._assertDelivery();
      }
    } catch (err) {
      abandoned = true;
      if (this.client === client) this.client = null;
      await this._endClient(client);
      throw err;
    }

    if (!this._isCurrent(generation)) {
      if (this.client === client) this.client = null;
      await this._endClient(client);
      return false;
    }

    const reconnected = this.state === 'started';
    this.reconnectAttempt = 0;
    log.info(`changeBus: subscribed to "${PARCAE_CHANNEL}"`);
    if (reconnected) {
      for (const listener of this.reconnectListeners) {
        try {
          listener();
        } catch (err) {
          log.warn(`changeBus: reconnect listener threw: ${String(err)}`);
        }
      }
    }
    return true;
  }

  /**
   * Prove this connection can actually receive what a row trigger sends.
   *
   * The notification is issued from a SECOND connection on purpose. A
   * transaction-mode pooler will happily deliver a notification a session
   * sends to itself in the same breath, because the server connection has
   * not been recycled yet — so a same-connection probe passes against a
   * pooled endpoint and proves nothing. Verified against Freia production:
   * self-notify was delivered on both the pooled and direct endpoints,
   * cross-connection was delivered only on the direct one. A trigger always
   * fires on some other connection, so that is the shape worth testing.
   *
   * A LISTEN that reports success but delivers nothing is silent by
   * construction: every consumer reads a healthy log line and gets no
   * events. Failing the connection sends it down the reconnect path, where
   * the error is logged on every attempt rather than once at startup.
   */
  private async _assertDelivery(): Promise<void> {
    const nonce = randomUUID();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const delivered = new Promise<boolean>((resolve) => {
      this.pendingProbe = { nonce, settle: resolve };
      timer = setTimeout(() => resolve(false), this.deliveryProbeTimeoutMs);
      timer.unref?.();
    });
    const notifier = new Client({
      connectionString: this.url,
      connectionTimeoutMillis: this.connectTimeoutMs,
    });
    // A failed notifier must not take the process down on its own error
    // event; the probe result below is the only verdict that counts.
    notifier.on('error', (err: Error) => {
      log.warn(`changeBus: probe notifier error: ${err.message}`);
    });
    try {
      await notifier.connect();
      await notifier.query('SELECT pg_notify($1, $2)', [
        PARCAE_CHANNEL,
        JSON.stringify({ [PROBE_KEY]: nonce }),
      ]);
      if (await delivered) return;
    } catch (err) {
      throw new Error(
        `changeBus: could not probe delivery on "${PARCAE_CHANNEL}": ${
          (err as Error).message
        }`,
      );
    } finally {
      if (timer) clearTimeout(timer);
      this.pendingProbe = null;
      await this._endClient(notifier);
    }
    throw new Error(
      `changeBus: LISTEN on "${PARCAE_CHANNEL}" succeeded but a notification ` +
        `sent from a second connection did not arrive within ` +
        `${this.deliveryProbeTimeoutMs}ms. This connection cannot carry a ` +
        'subscription, which a transaction-mode pooler does silently. Point ' +
        'the change bus at a direct endpoint.',
    );
  }

  /** True when the payload is our own probe, which listeners never see. */
  private _consumeProbe(raw: unknown): boolean {
    if (typeof raw !== 'string' || !raw.includes(PROBE_KEY)) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null) return false;
    const nonce = (parsed as Record<string, unknown>)[PROBE_KEY];
    if (typeof nonce !== 'string') return false;
    // Every process listening on the channel sees every other process's
    // probe. Only our own settles ours; the rest are still swallowed here,
    // because a probe is never a model change.
    if (this.pendingProbe?.nonce === nonce) this.pendingProbe.settle(true);
    return true;
  }

  private _trackConnect(generation: number): Promise<boolean> {
    const attempt = this._connect(generation);
    this.connectAttempt = attempt;
    return attempt.finally(() => {
      if (this.connectAttempt === attempt) this.connectAttempt = null;
    });
  }

  private _isCurrent(generation: number): boolean {
    return this.state !== 'stopped' && this.generation === generation;
  }

  private async _awaitConnect(setup: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancelled = new Promise<never>((_, reject) => {
      this.cancelConnect = () => reject(new Error('changeBus: connection cancelled'));
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `changeBus: connection timed out after ${this.connectTimeoutMs}ms`,
            ),
          ),
        this.connectTimeoutMs,
      );
    });
    try {
      await Promise.race([setup, cancelled, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      this.cancelConnect = null;
    }
  }

  private async _endClient(client: Client): Promise<void> {
    const existing = this.closingClients.get(client);
    if (existing) return existing;
    const closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          client.end(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.connectTimeoutMs);
            timer.unref?.();
          }),
        ]);
      } catch {
        // Already closed.
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    this.closingClients.set(client, closing);
    await closing;
  }

  private _scheduleReconnect(): void {
    if (this.state !== 'started' || this.reconnectTimer) return;
    const delay = Math.min(
      this.initialReconnectDelay * 2 ** this.reconnectAttempt,
      this.maxReconnectDelay,
    );
    this.reconnectAttempt++;
    log.info(
      `changeBus: reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state !== 'started') return;
      const generation = this.generation;
      const work = this._reconnect(generation);
      this.reconnectWork = work;
      void work.finally(() => {
        if (this.reconnectWork === work) this.reconnectWork = null;
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private _handleDisconnect(): void {
    if (this.state === 'starting') {
      this.disconnectedDuringStart = true;
      return;
    }
    this._scheduleReconnect();
  }

  private async _reconnect(generation: number): Promise<void> {
    if (!this._isCurrent(generation)) return;
    const dead = this.client;
    this.client = null;
    if (dead) await this._endClient(dead);
    if (!this._isCurrent(generation)) return;
    try {
      await this._trackConnect(generation);
    } catch (err) {
      log.warn(`changeBus: reconnect failed: ${(err as Error).message}`);
      if (this._isCurrent(generation)) this._scheduleReconnect();
    }
  }

  private _parse(raw: unknown): Change | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        typeof parsed.table !== 'string' ||
        typeof parsed.id !== 'string' ||
        !isChangeOp(parsed.op)
      ) {
        return null;
      }
      const changedFields = Array.isArray(parsed.changedFields)
        ? Array.from(
            new Set(
              parsed.changedFields.filter(
                (field): field is string => typeof field === 'string',
              ),
            ),
          )
        : null;
      return {
        table: parsed.table,
        op: parsed.op,
        id: parsed.id,
        changedFields,
      };
    } catch {
      return null;
    }
  }
}

function isChangeOp(value: unknown): value is ChangeOp {
  return value === 'insert' || value === 'update' || value === 'delete';
}
