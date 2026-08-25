/**
 * SocketTransport — Socket.IO with separated session/connection state.
 *
 * The transport owns three orthogonal concerns:
 *   - the underlying socket (Socket.IO)
 *   - the ConnectionMachine (is the wire usable?)
 *   - the SessionMachine (who is the user?)
 *
 * Wire protocol:
 *   client → server:  "hello" + { token } → ack({ userId })
 *   client → server:  "call" (RPC, unchanged)
 *   client → server:  "resync" + { queries: [...] } → ack(results)
 *   server → client:  "query:<hash>" ops streams (unchanged)
 *
 * Lifecycle invariants:
 *   - socket connect runs `hello` exactly once per connection
 *   - disconnect does NOT touch session state
 *   - reconnect emits a single `resync` event after `hello` resolves
 *   - session changes propagate through SessionMachine.resolve only
 */

import SocketIO from "socket.io-client";
import pako from "pako";
import { decompress } from "compress-json";
import { EventEmitter } from "eventemitter3";
import ShortId from "short-unique-id";
import type { Transport, RequestOptions } from "@parcae/model";
import { SESSION_BOUNDARY_ERRORS } from "@parcae/model";
import { SessionMachine } from "../session-machine";
import { ConnectionMachine } from "../connection-machine";
import { log } from "../log";

const DEFAULT_TIMEOUT = 120_000;
const WATCHDOG_STALE_MS = 8_000;
const WATCHDOG_BACKOFF_CAP_MS = 60_000;
/**
 * Ceiling on how long a call with no declared budget may sit unanswered
 * while other traffic flows. Past this the socket is rebuilt whatever
 * the rest of the wire is doing — see `_rpcStalled`.
 */
const RPC_STARVATION_MS = 30_000;
const KICK_FLOOR_MS = 2_000;

const uid = new ShortId({ length: 10 });

export interface SocketTransportConfig {
  url: string;
  version?: string;
  path?: string;
  /**
   * Async token resolver. Called once before the initial connect and
   * once on every reconnect (handing back the latest token from the
   * auth adapter). Return `null` for anonymous sessions.
   */
  getToken: () => Promise<string | null>;
  /**
   * socket.io transports list. Defaults to `["websocket"]` — the
   * fast path used by web, Node, and any runtime with a WebSocket
   * global. Pass `["polling"]` (or `["polling", "websocket"]`) for
   * runtimes that don't expose `WebSocket` natively (e.g. Lynx
   * PrimJS in a custom native shell without LynxWebSocketModule).
   */
  transports?: ("websocket" | "polling")[];
  /**
   * Extra headers attached to the socket handshake (the WebSocket
   * upgrade / polling requests). Applied in Node and React Native;
   * browsers cannot set custom WebSocket headers and silently
   * ignore these. The server sees them on
   * `socket.handshake.headers`, and the backend's socket RPC bridge
   * spreads handshake headers onto every synthetic request, so a
   * header set here reaches middleware like any per-request header.
   */
  extraHeaders?: Record<string, string>;
  /** Maximum time to wait for a hello acknowledgement. */
  handshakeTimeout?: number;
  /**
   * Dial the socket at construction (socket.io's default). Pass
   * `false` for connection-less transports — e.g. a client created
   * for SSR, where the tree renders once against a forever-`pending`
   * session and no wire traffic must leave the render server. The
   * connection machine stays `"idle"`; `reconnect()` dials on demand.
   */
  autoConnect?: boolean;
  /**
   * Watchdog stale threshold in ms. While the consumer reports the app
   * active, a transport that stays unready (socket not connected,
   * connected with hello unacked, or in-flight RPCs starved of any
   * response) this long is torn down and rebuilt with exponential
   * backoff. `0` disables the watchdog. Default 8000.
   */
  watchdogStaleMs?: number;
}

/** Point-in-time technical snapshot of the transport, for diagnostics. */
export interface TransportDiagnostics {
  connectionStatus: "idle" | "connecting" | "connected" | "disconnected";
  sessionStatus: "pending" | "anonymous" | "authenticated" | "terminated";
  msSinceHelloAttempt: number | null;
  msSinceHelloAck: number | null;
  subscriptionCount: number;
  recoveryAttempts: number;
  /** In-flight `call` RPCs plus in-flight resyncs. */
  pendingCallCount: number;
  /** Age of the oldest in-flight RPC/resync, null when none pending. */
  msSinceOldestPendingCall: number | null;
}

/** Wire shape for a single `resync` entry. */
export interface ResyncEntry {
  key: string;
  modelType: string;
  steps: unknown[];
  /** Last-known queryHash, so the server can skip resending unchanged subscriptions. */
  queryHash?: string | null;
  /**
   * `false` when the matching `useQuery` was mounted with
   * `{ subscribe: false }`. The server's resync handler takes the
   * static path for these entries — fresh fetch, no subscription
   * registered, `hash: null` in the result. Absence ⇒ subscribed
   * (legacy behaviour), so older backends remain compatible.
   */
  subscribe?: boolean;
}

/** Wire shape for a single resolved entry coming back from the server. */
export interface ResyncResult {
  key: string;
  /**
   * `null` for static (`subscribe: false`) entries — no subscription
   * was registered server-side, so there's no hash to attach a
   * `query:${hash}` listener to. The SDK uses this to short-circuit
   * the subscribe block in `_onResyncRequired`.
   */
  hash: string | null;
  items: any[];
  totalCount: number;
}

interface PendingWaiter {
  cleanup: () => void;
  reject: (error: Error) => void;
  /** Dispatch time for RPC-shaped waiters (resync); absent for
   * connection/termination waits, which the watchdog must not count. */
  sentAt?: number;
}

export class SocketTransport extends EventEmitter implements Transport {
  public session = new SessionMachine();
  public connection = new ConnectionMachine();

  private socket: any;
  private url: string;
  private version: string;
  private getToken: () => Promise<string | null>;
  private inflight = new Map<string, Promise<any>>();
  private pendingCalls = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      reject: (error: Error) => void;
      sentAt: number;
      /** Caller declared its own timeout; the stall clock skips it. */
      watchdogExempt?: boolean;
    }
  >();
  private pendingWaiters = new Set<PendingWaiter>();
  private handshakeTimeout: number;
  private sessionGeneration = 0;
  private activeHandshake: {
    generation: number;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private isDisposed = false;
  private helloGeneration = -1;
  private helloState: "idle" | "pending" | "resolved" | "rejected" = "idle";
  /** Settles when the most recent `hello` attempt settles. */
  private helloReady: Promise<void> = Promise.resolve();
  /** The token the server validated at the last resolved hello. */
  private confirmedHelloToken: string | null = null;
  /**
   * Raw-event delivery gate. False from the moment a session boundary
   * starts (new hello, termination, disconnect) until the server
   * confirms the next session, so a frame already in flight when the
   * identity changes is dropped instead of delivered to handlers that
   * belong to the prior session.
   */
  private sessionReadyForEvents = false;
  private watchdogStaleMs: number;
  private watchdogActive = true;
  private watchdogSuspended = false;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogUnhealthySince: number | null = null;
  private watchdogRecoveries = 0;
  private lastRpcResponseAt: number | null = null;
  private rpcStallRecoveryPending = false;
  private lastHelloAttemptAt: number | null = null;
  private lastHelloAckAt: number | null = null;
  private subscriptions = new Map<
    string,
    Map<(...args: any[]) => void, (...args: any[]) => void>
  >();

  constructor(config: SocketTransportConfig) {
    super();
    this.url = config.url;
    this.version = config.version ?? "v1";
    this.getToken = config.getToken;
    this.handshakeTimeout = config.handshakeTimeout ?? DEFAULT_TIMEOUT;
    this.watchdogStaleMs = config.watchdogStaleMs ?? WATCHDOG_STALE_MS;

    const socketPath = config.path ?? "/ws";
    const transports = config.transports ?? ["websocket"];
    const extraHeaders = config.extraHeaders;
    const autoConnect = config.autoConnect ?? true;
    this.socket = SocketIO(this.url, {
      path: socketPath,
      transports,
      withCredentials: true,
      autoConnect,
      ...(extraHeaders ? { extraHeaders } : {}),
    });

    if (autoConnect) this.connection.connecting();
    // A connection-less (SSR) transport must never be dialed by the
    // watchdog; `reconnect()` lifts the suspension when it dials.
    this.watchdogSuspended = !autoConnect;

    this.socket.on("connect", () => {
      if (this.isDisposed) return;
      this.connection.connected();
      this.emit("connected");
      void this._handshake().catch(() => {});
      this._scheduleWatchdog();
    });

    this.socket.on("disconnect", (reason?: string) => {
      // Critical: disconnect does NOT touch session.
      // Session is identity; identity outlives any single socket.
      this._handleSocketDisconnect(reason);
    });

    this.socket.on("connect_error", (err: Error) => {
      this._advanceGeneration(err);
      this.connection.disconnected(err);
      this.emit("error", err);
    });

    this.socket.on("error", (err: Error) => {
      this.emit("error", err);
    });

    if (this.socket.connected) {
      this.connection.connected();
      void this._handshake().catch(() => {});
    }
    this._scheduleWatchdog();
  }

  // ── Watchdog ─────────────────────────────────────────────────────
  //
  // The OS can suppress the device's network stack so the socket.io
  // engine wedges silently: no connect, no connect_error, no timers
  // firing, forever. Recovery is a full engine rebuild under the same
  // Socket: disconnect() destroys the wedged manager/engine state and
  // connect() builds a fresh engine while every listener stays attached.

  private _oldestPendingAt(): number | null {
    let oldest: number | null = null;
    for (const { sentAt, watchdogExempt } of this.pendingCalls.values()) {
      if (watchdogExempt) continue;
      if (oldest === null || sentAt < oldest) oldest = sentAt;
    }
    for (const { sentAt } of this.pendingWaiters) {
      if (sentAt === undefined) continue;
      if (oldest === null || sentAt < oldest) oldest = sentAt;
    }
    return oldest;
  }

  // A half-dead path can pass small frames (hello ack, pings) while
  // dropping RPC response frames, so "connected + hello acked" is not
  // proof of health. Stalled = the oldest in-flight RPC has waited a
  // full stale window with no response of any kind arriving after it
  // was dispatched. A response landing after dispatch proves the wire,
  // so a merely slow server never trips this.
  //
  // That proof expires. `lastRpcResponseAt` is one clock for the whole
  // socket, so a single answered call sits permanently ahead of a
  // starved call's dispatch time and masks it — and a screen mounting
  // a dozen queries at once always has something to answer. Past
  // RPC_STARVATION_MS the wire being alive stops being an excuse: a
  // call with no declared budget that the server has not answered in
  // half a minute is a dropped response, not a slow one, and only a
  // rebuild recovers it. Calls that declared their own timeout are
  // excluded from `_oldestPendingAt`, so a long-budget RPC never
  // reaches this.
  private _rpcStalled(): boolean {
    const oldest = this._oldestPendingAt();
    if (oldest === null) return false;
    const age = Date.now() - oldest;
    if (age < this.watchdogStaleMs) return false;
    if (age >= RPC_STARVATION_MS) return true;
    return this.lastRpcResponseAt === null || this.lastRpcResponseAt <= oldest;
  }

  private _noteRpcResponse(): void {
    this.lastRpcResponseAt = Date.now();
    if (this.rpcStallRecoveryPending) {
      this.rpcStallRecoveryPending = false;
      this.emit("rpc:recovered");
    }
  }

  private _stallReason(): "connect-stalled" | "hello-stalled" | "rpc-stalled" {
    if (!this.socket.connected) return "connect-stalled";
    if (!this.sessionReadyForEvents) return "hello-stalled";
    return "rpc-stalled";
  }

  private _watchdogHealthy(): boolean {
    return (
      this.socket.connected &&
      this.sessionReadyForEvents &&
      !this._rpcStalled()
    );
  }

  private _watchdogEligible(): boolean {
    return (
      this.watchdogStaleMs > 0 &&
      this.watchdogActive &&
      !this.watchdogSuspended &&
      !this.isDisposed &&
      this.session.state.status !== "terminated"
    );
  }

  private _scheduleWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (!this._watchdogEligible()) {
      this.watchdogUnhealthySince = null;
      return;
    }
    if (this._watchdogHealthy()) {
      this.watchdogUnhealthySince = null;
      this.watchdogRecoveries = 0;
      // Healthy with RPCs in flight: arm a check for the moment the
      // oldest pending call would cross the stale window, so a stall
      // that develops after this scheduling point is still noticed.
      const oldest = this._oldestPendingAt();
      if (oldest !== null) {
        // Two boundaries matter for a pending call: the stale window,
        // and the starvation floor that outlives any masking response.
        // Arming at the one already passed would spin the tick at its
        // 50ms minimum for the whole gap between them.
        const next =
          Date.now() - oldest < this.watchdogStaleMs
            ? this.watchdogStaleMs
            : RPC_STARVATION_MS;
        const delay = Math.max(oldest + next - Date.now(), 50);
        this.watchdogTimer = setTimeout(() => {
          this.watchdogTimer = null;
          this._watchdogTick();
        }, delay);
      }
      return;
    }
    if (this.watchdogUnhealthySince === null) {
      // For an RPC stall the transport has effectively been unhealthy
      // since the starved call went out, not since the stall was
      // noticed; anchoring backoff there recovers on the first tick.
      const oldest = this._oldestPendingAt();
      this.watchdogUnhealthySince =
        this._rpcStalled() && oldest !== null ? oldest : Date.now();
    }
    const backoff = Math.min(
      this.watchdogStaleMs * 2 ** this.watchdogRecoveries,
      WATCHDOG_BACKOFF_CAP_MS,
    );
    const delay = Math.max(
      this.watchdogUnhealthySince + backoff - Date.now(),
      50,
    );
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      this._watchdogTick();
    }, delay);
  }

  private _watchdogTick(): void {
    if (!this._watchdogEligible() || this._watchdogHealthy()) {
      this._scheduleWatchdog();
      return;
    }
    this._recoverStuckTransport(this._stallReason());
  }

  private _recoverStuckTransport(
    reason: "connect-stalled" | "hello-stalled" | "rpc-stalled",
  ): void {
    if (reason === "rpc-stalled") {
      this.rpcStallRecoveryPending = true;
    }
    this.watchdogRecoveries++;
    this.emit("watchdog:recover", {
      reason,
      attempt: this.watchdogRecoveries,
      diagnostics: this.diagnostics(),
    });
    log.warn(`watchdog: recovering (${reason})`);
    this.watchdogUnhealthySince = Date.now();
    try {
      this.socket.disconnect();
    } catch {
      log.warn("watchdog: teardown failed");
    }
    try {
      this.socket.connect();
    } catch {
      log.warn("watchdog: reconnect failed");
    }
    this._scheduleWatchdog();
  }

  /** Consumer's foreground signal. The watchdog only runs while active. */
  setActive(active: boolean): void {
    if (this.watchdogActive === active) return;
    this.watchdogActive = active;
    // Measure staleness from re-activation, not from however long the
    // app sat backgrounded with the socket legitimately idle.
    if (active) this.watchdogUnhealthySince = null;
    this._scheduleWatchdog();
  }

  /**
   * Consumer's "conditions changed, try now" signal (app foregrounded,
   * network came back). Resets the backoff and, when the transport has
   * been unhealthy past a short floor, recovers immediately.
   */
  kick(): void {
    this.watchdogRecoveries = 0;
    if (
      this._watchdogEligible() &&
      !this._watchdogHealthy() &&
      this.watchdogUnhealthySince !== null &&
      Date.now() - this.watchdogUnhealthySince >= KICK_FLOOR_MS
    ) {
      this._recoverStuckTransport(this._stallReason());
      return;
    }
    this._scheduleWatchdog();
  }

  diagnostics(): TransportDiagnostics {
    const oldestPending = this._oldestPendingAt();
    let pendingResyncCount = 0;
    for (const { sentAt } of this.pendingWaiters) {
      if (sentAt !== undefined) pendingResyncCount++;
    }
    return {
      connectionStatus: this.connection.state.status,
      sessionStatus: this.session.state.status,
      msSinceHelloAttempt:
        this.lastHelloAttemptAt === null
          ? null
          : Date.now() - this.lastHelloAttemptAt,
      msSinceHelloAck:
        this.lastHelloAckAt === null
          ? null
          : Date.now() - this.lastHelloAckAt,
      subscriptionCount: this.subscriptions.size,
      recoveryAttempts: this.watchdogRecoveries,
      pendingCallCount: this.pendingCalls.size + pendingResyncCount,
      msSinceOldestPendingCall:
        oldestPending === null ? null : Date.now() - oldestPending,
    };
  }

  // ── Hello / resync handshake ─────────────────────────────────────

  private _handshake(fresh = false): Promise<void> {
    if (this.isDisposed) return Promise.reject(new Error("Transport disposed"));
    if (!this.socket.connected) {
      return Promise.reject(new Error("Cannot handshake while disconnected"));
    }

    if (
      !fresh &&
      this.helloGeneration === this.sessionGeneration &&
      (this.helloState === "pending" || this.helloState === "resolved")
    ) {
      return this.helloReady;
    }
    if (fresh) this._advanceGeneration(new Error("Hello superseded"));
    const generation = this.sessionGeneration;
    this.helloGeneration = generation;
    this.helloState = "pending";
    this.sessionReadyForEvents = false;
    this.lastHelloAttemptAt = Date.now();
    this.inflight.clear();

    let resolveHello!: () => void;
    let rejectHello!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveHello = resolve;
      rejectHello = reject;
    });
    // Fetch callers still receive the rejection; this handler only
    // prevents an unobserved reconnect handshake from becoming global.
    void ready.catch(() => {});
    this.helloReady = ready;
    this.activeHandshake = {
      generation,
      reject: rejectHello,
      timer: null,
    };
    this.activeHandshake.timer = setTimeout(() => {
      this._rejectHandshake(generation, new Error("Hello timeout"));
    }, this.handshakeTimeout);

    void this.getToken().then(
      (token) => {
        const active = this.activeHandshake;
        if (!active || active.generation !== generation) return;
        if (!this.socket.connected) {
          this._rejectHandshake(
            generation,
            new Error("Disconnected before hello"),
          );
          return;
        }

        const t0 = performance.now();
        this.socket.emit("hello", { token }, (response: any) => {
          const current = this.activeHandshake;
          if (!current || current.generation !== generation) return;
          if (!response || response.success === false) {
            this._rejectHandshake(
              generation,
              new Error(
                response?.error ||
                  response?.message ||
                  "Missing hello acknowledgement",
              ),
            );
            return;
          }

          if (current.timer) clearTimeout(current.timer);
          this.activeHandshake = null;
          this.helloState = "resolved";
          const userId = response.userId ?? null;
          const ms = (performance.now() - t0).toFixed(0);
          log.debug(
            `hello: ${userId ? `userId=${userId}` : "anonymous"} (${ms}ms)`,
          );
          this.lastHelloAckAt = Date.now();
          this.session.resolve(userId);
          this.confirmedHelloToken = token;
          this.sessionReadyForEvents = true;
          this._scheduleWatchdog();
          resolveHello();
          this.emit("resync-required");
        });
      },
      (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log.warn(`hello: token resolution failed (${error.message})`);
        this._rejectHandshake(generation, error);
      },
    );

    return ready;
  }

  private _rejectHandshake(generation: number, error: Error): void {
    const active = this.activeHandshake;
    if (!active || active.generation !== generation) return;
    if (active.timer) clearTimeout(active.timer);
    this.activeHandshake = null;
    this.helloState = "rejected";
    active.reject(error);
    this.emit("error", error);
  }

  private _advanceGeneration(error: Error): void {
    this.sessionGeneration++;
    this.inflight.clear();
    this.helloState = "rejected";
    this.sessionReadyForEvents = false;
    this._rejectPending(error);
    const active = this.activeHandshake;
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    this.activeHandshake = null;
    active.reject(error);
  }

  private _handleSocketDisconnect(reason?: string): void {
    if (this.connection.state.status === "disconnected") return;
    this._advanceGeneration(
      new Error(reason ? `Disconnected: ${reason}` : "Disconnected"),
    );
    this.connection.disconnected();
    this.emit("disconnected");
    this._scheduleWatchdog();
  }

  private _trackWaiter(
    reject: (error: Error) => void,
    cleanup: () => void,
    sentAt?: number,
  ): () => void {
    const waiter: PendingWaiter = { reject, cleanup, sentAt };
    this.pendingWaiters.add(waiter);
    return () => {
      if (!this.pendingWaiters.delete(waiter)) return;
      cleanup();
    };
  }

  private _rejectPending(error: Error): void {
    for (const [id, call] of this.pendingCalls) {
      clearTimeout(call.timer);
      this.socket.off(id);
      call.reject(error);
    }
    this.pendingCalls.clear();
    for (const waiter of [...this.pendingWaiters]) {
      this.pendingWaiters.delete(waiter);
      waiter.cleanup();
      waiter.reject(error);
    }
  }

  /**
   * Resync RPC. Used by `useQuery` after every reconnect to
   * re-establish server-side query subscriptions in a single round
   * trip. Returns the freshly-evaluated results for every entry.
   */
  async resync(entries: ResyncEntry[]): Promise<ResyncResult[]> {
    if (entries.length === 0) return [];
    await this.helloReady;
    return new Promise((resolve, reject) => {
      let settled = false;
      let release = () => {};
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        release();
        reject(error);
      };
      const timeout = setTimeout(() => {
        fail(new Error("resync timeout"));
      }, DEFAULT_TIMEOUT);
      release = this._trackWaiter(fail, () => clearTimeout(timeout), Date.now());
      this._scheduleWatchdog();
      this.socket.emit("resync", { queries: entries }, (response: any) => {
        this._noteRpcResponse();
        if (settled) return;
        settled = true;
        release();
        if (response?.success === false) {
          reject(new Error(response?.error || "resync failed"));
          return;
        }
        resolve(response?.results ?? []);
      });
    });
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Token rotation / explicit sign-in. Triggers a fresh hello on the
   * existing socket so the server updates its socket→session mapping.
   * Sign-out path (token === null) goes through `terminate()`.
   *
   * If the session was previously terminated (sign-out), this resets
   * the machine back to "pending" before handshaking. That covers the
   * sign-out → sign-in-again flow in long-lived single-page apps where
   * the same SDK client is reused across multiple user identities.
   */
  async refreshSession(): Promise<{ userId: string | null }> {
    if (this.session.state.status === "terminated") {
      this.session.reset();
    }
    await this._handshake(true);
    return { userId: this.session.state.userId };
  }

  /** The token the server validated at the last hello, null before the first
   * one and after sign-out. The authorization baseline for rotation
   * comparisons: it can never run ahead of the server's session. */
  lastConfirmedToken(): string | null {
    return this.confirmedHelloToken;
  }

  /** Explicit sign-out. Marks the session terminated and drops the socket auth. */
  async terminateSession(): Promise<void> {
    this.confirmedHelloToken = null;
    this.session.terminate();
    this._advanceGeneration(new Error(SESSION_BOUNDARY_ERRORS.terminated));
    this._scheduleWatchdog();
    if (this.socket.connected) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let release = () => {};
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          release();
          reject(error);
        };
        const timeout = setTimeout(() => {
          fail(new Error("Session termination timeout"));
        }, this.handshakeTimeout);
        release = this._trackWaiter(fail, () => clearTimeout(timeout));
        this.socket.emit("hello", { token: null }, (response: any) => {
          if (settled) return;
          settled = true;
          release();
          if (!response || response.success === false) {
            reject(
              new Error(
                response?.error ||
                  response?.message ||
                  "Missing session termination acknowledgement",
              ),
            );
            return;
          }
          resolve();
        });
      });
    }
  }

  get isConnected(): boolean {
    return this.connection.state.status === "connected";
  }

  private _assertCanRequest(): void {
    if (this.isDisposed) throw new Error("Transport disposed");
    if (this.session.state.status === "terminated") {
      throw new Error(SESSION_BOUNDARY_ERRORS.terminated);
    }
  }

  private _waitForConnection(): Promise<void> {
    if (this.socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let release = () => {};
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        release();
        reject(error);
      };
      const timeout = setTimeout(() => {
        fail(new Error("Connection timeout"));
      }, DEFAULT_TIMEOUT);
      const onConnect = () => {
        if (settled) return;
        settled = true;
        release();
        resolve();
      };
      const onError = (error: Error) => fail(error);
      const cleanup = () => {
        clearTimeout(timeout);
        this.socket.off("connect", onConnect);
        this.socket.off("connect_error", onError);
      };
      release = this._trackWaiter(fail, cleanup);
      this.socket.once("connect", onConnect);
      this.socket.once("connect_error", onError);
    });
  }

  // ── Request/Response ─────────────────────────────────────────────

  private async fetch(
    method: string,
    path: string,
    data: any = {},
    options?: RequestOptions,
  ): Promise<any> {
    this._assertCanRequest();

    // Wait for the first hello to land — guarantees the socket is
    // authenticated before the call goes out. Subsequent calls don't
    // re-await because `helloReady` resolves once and stays resolved
    // until the next reconnect kicks a new handshake.
    await this.helloReady;

    if (!this.socket.connected) {
      await this._waitForConnection();
      await this.helloReady;
    }

    this._assertCanRequest();

    const upper = method.toUpperCase();
    if (upper === "GET") {
      const dedupeKey = `${this.sessionGeneration}:${path}:${JSON.stringify(data)}`;
      const existing = this.inflight.get(dedupeKey);
      if (existing) return existing;
      const req = this._call(method, path, data, options);
      this.inflight.set(dedupeKey, req);
      req.then(
        () => this.inflight.delete(dedupeKey),
        () => this.inflight.delete(dedupeKey),
      );
      return req;
    }

    return this._call(method, path, data, options);
  }

  private _call(
    method: string,
    path: string,
    data: any,
    options?: RequestOptions,
  ): Promise<any> {
    const id = uid.rnd();
    const t0 = performance.now();
    const fullPath = `/${this.version}${path}`;
    const timeoutMs = options?.timeout ?? DEFAULT_TIMEOUT;
    log.debug(`→ ${method.toUpperCase()} ${fullPath}`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.socket.off(id);
        this.pendingCalls.delete(id);
        this._scheduleWatchdog();
        log.debug(
          `✗ ${method.toUpperCase()} ${fullPath} timeout (${(timeoutMs / 1000).toFixed(0)}s)`,
        );
        reject(new Error(`RPC timeout: ${method} ${path}`));
      }, timeoutMs);
      this.pendingCalls.set(id, {
        timer: timeout,
        reject,
        sentAt: Date.now(),
        // A caller that declared its own timeout has told us the
        // budget for this call; the watchdog must not second-guess it
        // at the stale window. Server work that legitimately runs for
        // tens of seconds (LLM generation, imports) is the sole
        // in-flight RPC exactly when the user is waiting on it, and
        // tearing the socket down mid-wait rejects a call the server
        // goes on to complete and persist.
        watchdogExempt: options?.timeout !== undefined,
      });

      this.socket.once(id, (msg: any) => {
        // Any response frame proves the wire is alive.
        this._noteRpcResponse();
        clearTimeout(timeout);
        this.pendingCalls.delete(id);
        this._scheduleWatchdog();
        const ms = (performance.now() - t0).toFixed(0);
        try {
          const uncompressed = pako.ungzip(msg, { to: "string" });
          const parsed = decompress(JSON.parse(uncompressed));
          if (parsed.success) {
            log.debug(`← ${method.toUpperCase()} ${fullPath} (${ms}ms)`);
            resolve(parsed.result);
          } else {
            log.debug(
              `✗ ${method.toUpperCase()} ${fullPath} (${ms}ms) ${parsed.error || parsed.message}`,
            );
            const details =
              parsed.error && typeof parsed.error === "object"
                ? parsed.error
                : parsed;
            const error = Object.assign(
              new Error(
                details.message ||
                  (typeof parsed.error === "string" ? parsed.error : null) ||
                  parsed.message ||
                `${method} ${path} failed`,
              ),
              {
                ...(typeof (details.status ?? parsed.status) === "number"
                  ? { status: details.status ?? parsed.status }
                  : {}),
                ...(typeof (details.code ?? parsed.code) === "string"
                  ? { code: details.code ?? parsed.code }
                  : {}),
              },
            );
            reject(error);
          }
        } catch (err) {
          log.debug(
            `✗ ${method.toUpperCase()} ${fullPath} (${ms}ms) parse error`,
          );
          reject(err);
        }
      });

      this.socket.emit(
        "call",
        id,
        method.toUpperCase(),
        `/${this.version}${path}`,
        data,
      );
      this._scheduleWatchdog();
    });
  }

  async get(path: string, data?: any, options?: RequestOptions): Promise<any> {
    return this.fetch("GET", path, data, options);
  }
  async post(path: string, data?: any, options?: RequestOptions): Promise<any> {
    return this.fetch("POST", path, data, options);
  }
  async put(path: string, data?: any, options?: RequestOptions): Promise<any> {
    return this.fetch("PUT", path, data, options);
  }
  async patch(
    path: string,
    data?: any,
    options?: RequestOptions,
  ): Promise<any> {
    return this.fetch("PATCH", path, data, options);
  }
  async delete(
    path: string,
    data?: any,
    options?: RequestOptions,
  ): Promise<any> {
    return this.fetch("DELETE", path, data, options);
  }

  subscribe(event: string, handler: (...args: any[]) => void): () => void {
    let eventSubscriptions = this.subscriptions.get(event);
    if (!eventSubscriptions) {
      eventSubscriptions = new Map();
      this.subscriptions.set(event, eventSubscriptions);
    }
    const existing = eventSubscriptions.get(handler);
    if (existing) this.socket.off(event, existing);

    const wrapper = (...args: any[]) => {
      // A subscription frame is a full data frame: it proves the wire
      // passes more than pings, so it resets the RPC stall clock even
      // when the boundary gate below drops it.
      this._noteRpcResponse();
      // A frame in flight across a session boundary belongs to the
      // session that was live when the server sent it; drop it.
      if (this.sessionReadyForEvents) handler(...args);
    };
    eventSubscriptions.set(handler, wrapper);
    this.socket.on(event, wrapper);

    return () => {
      this.socket.off(event, wrapper);
      if (eventSubscriptions?.get(handler) === wrapper) {
        eventSubscriptions.delete(handler);
        if (eventSubscriptions.size === 0) this.subscriptions.delete(event);
      }
    };
  }

  unsubscribe(event: string, handler?: (...args: any[]) => void): void {
    const eventSubscriptions = this.subscriptions.get(event);
    if (!handler) {
      if (eventSubscriptions) {
        for (const wrapper of eventSubscriptions.values()) {
          this.socket.off(event, wrapper);
        }
        this.subscriptions.delete(event);
      } else {
        this.socket.off(event);
      }
      return;
    }
    const wrapper = eventSubscriptions?.get(handler);
    if (!wrapper) return;
    this.socket.off(event, wrapper);
    eventSubscriptions?.delete(handler);
    if (eventSubscriptions?.size === 0) this.subscriptions.delete(event);
  }

  send(event: string, ...args: any[]): void {
    this.socket.emit(event, ...args);
  }

  disconnect(): void {
    this.watchdogSuspended = true;
    if (!this.socket.connected) this._handleSocketDisconnect();
    this.socket.disconnect();
    this._scheduleWatchdog();
  }

  async reconnect(): Promise<void> {
    if (this.isDisposed) throw new Error("Transport disposed");
    this.watchdogSuspended = false;
    this._scheduleWatchdog();
    if (this.socket.connected) {
      if (this.helloState === "rejected" || this.helloState === "idle") {
        await this._handshake(true);
      } else {
        await this.helloReady;
      }
      return;
    }

    this.connection.connecting();
    const connected = this._waitForConnection();
    this.socket.connect();
    await connected;
    await this.helloReady;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this._scheduleWatchdog();
    this._advanceGeneration(new Error("Transport disposed"));
    this.emit("dispose");
    this.socket.removeAllListeners?.();
    this.socket.disconnect();
    this.inflight.clear();
    this.subscriptions.clear();
    this.removeAllListeners();
    this.connection.disconnected();
  }
}
