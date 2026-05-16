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
 * v1 known limitation
 * ───────────────────
 * Bare `Model.save()` / `model.patch()` calls (i.e. NOT wrapped in
 * `withTransaction`) don't set the `parcae.request_id` GUC, so the
 * LISTEN trigger emits an empty requestId. The bus's dedup map has
 * the real requestId from the hook emit but they won't match — both
 * the hook emit AND the LISTEN echo will reach the subscription
 * manager and trigger debounced re-evals.
 *
 * The per-cached-query debounce (25ms by default) collapses the two
 * `onModelChange` calls into a single DB re-query in most cases. The
 * second re-eval after the debounce window produces an empty diff
 * (data is unchanged), so the wire cost is zero. There's a real
 * extra DB read cost when the two events straddle the debounce.
 *
 * Wrap critical hot paths in `withTransaction({ setRequestIdGuc:
 * true }, ...)` until DOL-895 (follow-up) ships the adapter-level
 * per-write GUC wrapping.
 */

import { Client } from "pg";

import { log } from "../logger";
import type { ChangeBus, ChangeOp } from "./changeBus";

// ─── Constants ──────────────────────────────────────────────────────────────

export const PARCAE_CHANNEL = "parcae_change";

const INITIAL_RECONNECT_DELAY = 500;
const MAX_RECONNECT_DELAY = 30_000;

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
  private client: Client | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;

  constructor(opts: ListenNotifyPollerOptions) {
    this.url = opts.url;
    this.changeBus = opts.changeBus;
    this.initialReconnectDelay =
      opts.initialReconnectDelay ?? INITIAL_RECONNECT_DELAY;
    this.maxReconnectDelay = opts.maxReconnectDelay ?? MAX_RECONNECT_DELAY;
  }

  /**
   * Open the dedicated pg client and subscribe to the parcae channel.
   * Throws if the initial connection fails — callers should treat that
   * as "external-write capture unavailable" and gracefully degrade
   * (the hook-path still works for Parcae-originated writes).
   */
  async start(): Promise<void> {
    this.stopped = false;
    await this._connect();
  }

  /** Close the pg client and stop reconnecting. Safe to call multiple times. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.end();
      } catch {
        // pg already in a closed state — fine.
      }
    }
  }

  // ── Internal ───────────────────────────────────────────────────────

  private async _connect(): Promise<void> {
    const client = new Client({ connectionString: this.url });

    // Hook listeners BEFORE connecting so we don't race against the
    // first error/notification.
    client.on("error", (err: Error) => {
      log.warn(`listenNotify: client error: ${err.message}`);
      this._scheduleReconnect();
    });
    client.on("end", () => {
      // Unexpected `end` (server closed the connection, network blip,
      // etc) — schedule a reconnect. If we initiated the end via
      // `stop()`, `stopped` is true and we short-circuit there.
      if (!this.stopped) {
        this._scheduleReconnect();
      }
    });
    client.on("notification", (msg) => {
      this._handleNotification(msg);
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${PARCAE_CHANNEL}`);
    } catch (err) {
      // Tear down the half-built client so we don't leak it. Don't
      // swallow on the initial connect — the caller logs and treats
      // this as "poller disabled". Subsequent reconnects handle their
      // own errors via the `error` event above.
      try {
        await client.end();
      } catch {}
      throw err;
    }

    this.client = client;
    this.reconnectAttempt = 0;
    log.info(`listenNotify: subscribed to "${PARCAE_CHANNEL}"`);
  }

  private _scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return; // already scheduled
    const delay = Math.min(
      this.initialReconnectDelay * 2 ** this.reconnectAttempt,
      this.maxReconnectDelay,
    );
    this.reconnectAttempt++;
    log.info(
      `listenNotify: reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      // Drop the dead client first so error handlers from it don't
      // re-enter this function.
      const dead = this.client;
      this.client = null;
      if (dead) {
        try {
          await dead.end();
        } catch {}
      }
      try {
        await this._connect();
      } catch (err) {
        log.warn(
          `listenNotify: reconnect failed: ${(err as Error).message}`,
        );
        this._scheduleReconnect();
      }
    }, delay);
    if (typeof this.reconnectTimer.unref === "function") {
      this.reconnectTimer.unref();
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
