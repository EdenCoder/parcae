/**
 * LISTEN/NOTIFY poller — captures external writes via Postgres triggers.
 *
 * Parcae's hook path covers every write that goes through the adapter,
 * but raw SQL, migrations, ops-console hot-fixes, and any future
 * out-of-band tooling bypass it. This module listens for Postgres
 * NOTIFYs emitted by the `parcae_change_notify()` trigger and routes
 * them onto the ChangeBus with `source: "listen"`. The bus's dedup
 * layer drops the LISTEN echo of a hook-path emit that came from the
 * same `parcae.request_id` (set via `withTransaction` or its
 * equivalent inline `SET LOCAL parcae.request_id` in the adapter).
 *
 * Connection contract
 * ───────────────────
 * We can't use a knex-pooled connection because knex hands a
 * connection back to the pool after every query, which kills any
 * outstanding `LISTEN` cursor. We open a dedicated `pg.Client` and
 * reconnect with exponential backoff if it drops.
 *
 * On reconnect: clients may have missed events during the gap, so
 * the drift-poll on `useQuery` is the safety net — without it, you
 * can't tell whether your view is up to date or stale across a
 * poller outage.
 *
 */

import { Client } from "pg";

import { log } from "../logger";
import type { ChangeBus, ChangeOp } from "./changeBus";

// ─── Constants ──────────────────────────────────────────────────────────────

export const PARCAE_CHANNEL = "parcae_change";

const INITIAL_RECONNECT_DELAY = 500;
const MAX_RECONNECT_DELAY = 30_000;
const CONNECT_TIMEOUT = 10_000;

// ─── Types ──────────────────────────────────────────────────────────────────

interface ListenNotifyPollerOptions {
  /** Postgres connection string. Reused from `config.DATABASE_URL`. */
  url: string;
  /** Bus to forward parsed Changes onto. */
  changeBus: ChangeBus;
  /**
   * Initial reconnect delay in ms. Doubles up to `maxReconnectDelay`.
   * Default `500`.
   */
  initialReconnectDelay?: number;
  /** Max reconnect delay in ms. Default `30_000`. */
  maxReconnectDelay?: number;
  /** Maximum time for connection setup or cancellation. Default `10_000`. */
  connectTimeoutMs?: number;
}

interface NotificationPayload {
  table: string;
  op: string; // "insert" | "update" | "delete"
  id: string;
  requestId?: string;
}

// ─── Poller ─────────────────────────────────────────────────────────────────

export class ListenNotifyPoller {
  private url: string;
  private changeBus: ChangeBus;
  private initialReconnectDelay: number;
  private maxReconnectDelay: number;
  private connectTimeoutMs: number;
  private client: Client | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private state: "stopped" | "starting" | "started" = "stopped";
  private generation = 0;
  private connectAttempt: Promise<boolean> | null = null;
  private reconnectWork: Promise<void> | null = null;
  private cancelConnect: (() => void) | null = null;
  private closingClients = new WeakMap<Client, Promise<void>>();

  constructor(opts: ListenNotifyPollerOptions) {
    this.url = opts.url;
    this.changeBus = opts.changeBus;
    this.initialReconnectDelay =
      opts.initialReconnectDelay ?? INITIAL_RECONNECT_DELAY;
    this.maxReconnectDelay = opts.maxReconnectDelay ?? MAX_RECONNECT_DELAY;
    this.connectTimeoutMs = Math.max(1, opts.connectTimeoutMs ?? CONNECT_TIMEOUT);
  }

  /**
   * Open the dedicated pg client and subscribe to the parcae channel.
   * Throws if the initial connection fails — callers should treat that
   * as "external-write capture unavailable" and gracefully degrade
   * (the hook-path still works for Parcae-originated writes).
   */
  async start(): Promise<void> {
    if (this.state !== "stopped") {
      throw new Error(`listenNotify: cannot start while ${this.state}`);
    }
    this.state = "starting";
    const generation = ++this.generation;
    try {
      const connected = await this._trackConnect(generation);
      if (!connected) throw new Error("listenNotify: stopped during startup");
      this.state = "started";
    } catch (err) {
      if (this.generation === generation) this.state = "stopped";
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.generation !== generation) {
        throw new Error("listenNotify: stopped during startup");
      }
      throw err;
    }
  }

  /** Close the pg client and stop reconnecting. Safe to call multiple times. */
  async stop(): Promise<void> {
    this.state = "stopped";
    this.generation++;
    this.cancelConnect?.();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    if (client) await this._endClient(client);
    const pending: Promise<unknown>[] = [];
    if (this.connectAttempt) pending.push(this.connectAttempt);
    if (this.reconnectWork) pending.push(this.reconnectWork);
    if (pending.length > 0) await Promise.allSettled(pending);
  }

  // ── Internal ───────────────────────────────────────────────────────

  private async _connect(generation: number): Promise<boolean> {
    const client = new Client({
      connectionString: this.url,
      connectionTimeoutMillis: this.connectTimeoutMs,
    });
    this.client = client;

    // Hook listeners BEFORE connecting so we don't race against the
    // first error/notification.
    client.on("error", (err: Error) => {
      log.warn(`listenNotify: client error: ${err.message}`);
      if (
        this.state === "started" &&
        this.generation === generation &&
        this.client === client
      ) {
        this._scheduleReconnect();
      }
    });
    client.on("end", () => {
      // Unexpected `end` (server closed the connection, network blip,
      // etc) — schedule a reconnect. If we initiated the end via
      // `stop()`, `stopped` is true and we short-circuit there.
      if (
        this.state === "started" &&
        this.generation === generation &&
        this.client === client
      ) {
        this._scheduleReconnect();
      }
    });
    client.on("notification", (msg) => {
      this._handleNotification(msg);
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
    } catch (err) {
      // Tear down the half-built client so we don't leak it. Don't
      // swallow on the initial connect — the caller logs and treats
      // this as "poller disabled". Subsequent reconnects handle their
      // own errors via the `error` event above.
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

    this.reconnectAttempt = 0;
    log.info(`listenNotify: subscribed to "${PARCAE_CHANNEL}"`);
    return true;
  }

  private async _trackConnect(generation: number): Promise<boolean> {
    const attempt = this._connect(generation);
    this.connectAttempt = attempt;
    try {
      return await attempt;
    } finally {
      if (this.connectAttempt === attempt) this.connectAttempt = null;
    }
  }

  private _isCurrent(generation: number): boolean {
    return this.state !== "stopped" && this.generation === generation;
  }

  private async _awaitConnect(setup: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancelled = new Promise<never>((_, reject) => {
      this.cancelConnect = () => reject(new Error("listenNotify: connection cancelled"));
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`listenNotify: connection timed out after ${this.connectTimeoutMs}ms`)),
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
            if (typeof timer.unref === "function") timer.unref();
          }),
        ]);
      } catch {
        // pg already in a closed state — fine.
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    this.closingClients.set(client, closing);
    await closing;
  }

  private _scheduleReconnect(): void {
    if (this.state !== "started") return;
    if (this.reconnectTimer) return; // already scheduled
    const delay = Math.min(
      this.initialReconnectDelay * 2 ** this.reconnectAttempt,
      this.maxReconnectDelay,
    );
    this.reconnectAttempt++;
    log.info(
      `listenNotify: reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state !== "started") return;
      const generation = this.generation;
      const work = this._reconnect(generation);
      this.reconnectWork = work;
      const clear = () => {
        if (this.reconnectWork === work) this.reconnectWork = null;
      };
      void work.then(clear, clear);
    }, delay);
    if (typeof this.reconnectTimer.unref === "function") {
      this.reconnectTimer.unref();
    }
  }

  private async _reconnect(generation: number): Promise<void> {
    if (!this._isCurrent(generation)) return;
    // Drop the dead client first so error handlers from it don't
    // re-enter this function.
    const dead = this.client;
    this.client = null;
    if (dead) await this._endClient(dead);
    if (!this._isCurrent(generation)) return;
    try {
      await this._trackConnect(generation);
    } catch (err) {
      log.warn(
        `listenNotify: reconnect failed: ${(err as Error).message}`,
      );
      if (this._isCurrent(generation)) this._scheduleReconnect();
    }
  }

  private _handleNotification(msg: any): void {
    if (!msg || typeof msg !== "object") return;
    if (msg.channel !== PARCAE_CHANNEL) return;
    const payload = this._parsePayload(msg.payload);
    if (!payload) return;
    if (!isChangeOp(payload.op)) return;

    this.changeBus.emit({
      table: payload.table,
      op: payload.op,
      id: payload.id,
      requestId: payload.requestId ?? "",
      source: "listen",
    });
  }

  private _parsePayload(raw: unknown): NotificationPayload | null {
    if (typeof raw !== "string" || raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof parsed.table !== "string" ||
        typeof parsed.op !== "string" ||
        typeof parsed.id !== "string"
      ) {
        return null;
      }
      const requestId =
        typeof parsed.requestId === "string" ? parsed.requestId : undefined;
      return {
        table: parsed.table,
        op: parsed.op,
        id: parsed.id,
        requestId,
      };
    } catch {
      return null;
    }
  }
}

function isChangeOp(s: string): s is ChangeOp {
  return s === "insert" || s === "update" || s === "delete";
}
