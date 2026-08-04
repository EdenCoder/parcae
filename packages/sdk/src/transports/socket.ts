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
import { SessionMachine } from "../session-machine";
import { ConnectionMachine } from "../connection-machine";
import { log } from "../log";

const DEFAULT_TIMEOUT = 120_000;
const HANDSHAKE_CANCELLED = Symbol("handshake-cancelled");
const ANONYMOUS_TOKEN_RESOLVER = async (): Promise<null> => null;
const WATCHDOG_STALE_MS = 8_000;
const WATCHDOG_BACKOFF_CAP_MS = 60_000;
const KICK_FLOOR_MS = 2_000;

const uid = new ShortId({ length: 10 });

/** @internal — retained as a test compatibility no-op; sockets are not pooled. */
export function _resetSockets(): void {
  // Each transport owns its socket, so there is no global registry to clear.
}

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
  /**
   * Watchdog stale threshold in ms. While the consumer reports the app
   * active, a transport that stays unready (socket not connected, or
   * connected with hello unacked) this long is torn down and rebuilt
   * with exponential backoff. `0` disables the watchdog. Default 8000.
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
  /**
   * Last-known query hash carried for protocol continuity. The current server
   * still re-authorizes and re-evaluates every resync entry.
   */
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
   * `false` means the requested model/query is unavailable to the current
   * session. The SDK scrubs the prior result in place and drops its listener.
   * Absent is accepted as `true` for compatibility with older backends.
   */
  authorized?: boolean;
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

export class SocketTransport extends EventEmitter implements Transport {
  public session = new SessionMachine();
  public connection = new ConnectionMachine();

  private socket: any;
  private url: string;
  private version: string;
  private getToken: () => Promise<string | null>;
  private tokenResolverRevision = 0;
  private reconciledTokenResolverRevision = 0;
  private tokenResolverLease: object | null = null;
  private sessionOperationGeneration = 0;
  private sessionBoundaryGeneration = 0;
  private authorizationGeneration = 0;
  private handshakeAttemptGeneration = 0;
  private sessionReadyForEvents = false;
  private hasResolvedSession = false;
  private confirmedHelloToken: string | null = null;
  private inflight = new Map<string, Promise<any>>();
  private pendingCalls = new Map<
    string,
    { cancel: (error: Error) => void; sentAt: number }
  >();
  private pendingResyncs = new Map<(error: Error) => void, number>();
  private pendingConnectionWaits = new Set<(error: Error) => void>();
  private pendingEventAcknowledgements = new Map<
    symbol,
    (...args: any[]) => void
  >();
  private subscriptions = new Map<
    string,
    Map<
      (...args: any[]) => void,
      { authorization: number; wrapper: (...args: any[]) => void }
    >
  >();
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
  /** Resolves when the most recent `hello` ack lands. */
  private helloReady: Promise<void> = Promise.resolve();
  private pendingHandshake: {
    attempt: number;
    cancel: () => void;
  } | null = null;
  private pendingTermination: {
    operation: number;
    cancel: () => void;
  } | null = null;

  constructor(config: SocketTransportConfig) {
    super();
    this.url = config.url;
    this.version = config.version ?? "v1";
    this.getToken = config.getToken;
    this.watchdogStaleMs = config.watchdogStaleMs ?? WATCHDOG_STALE_MS;

    const socketPath = config.path ?? "/ws";
    const transports = [...(config.transports ?? ["websocket"])];
    const extraHeaders = config.extraHeaders
      ? { ...config.extraHeaders }
      : undefined;
    // Client caching owns reuse. Each transport gets one physical socket so
    // independent API versions/auth resolvers cannot overwrite or disconnect
    // one another's server session.
    this.socket = SocketIO(this.url, {
      path: socketPath,
      transports,
      withCredentials: true,
      ...(extraHeaders ? { extraHeaders } : {}),
    });

    this.connection.connecting();

    this.socket.on("connect", () => {
      this.connection.connected();
      this.emit("connected");
      void this._handshake().catch(() => {});
      this._scheduleWatchdog();
    });

    this.socket.on("disconnect", () => {
      // Critical: disconnect does NOT touch session.
      // Session is identity; identity outlives any single socket.
      this._cancelPendingHandshake();
      this._cancelPendingTermination();
      this.sessionBoundaryGeneration++;
      this.sessionReadyForEvents = false;
      this._cancelPendingDataOperations(
        new Error("Parcae connection closed during request"),
      );
      this._clearEventAcknowledgements();
      this.connection.disconnected();
      this.emit("disconnected");
      this._scheduleWatchdog();
    });

    this.socket.on("error", (err: Error) => {
      this.connection.disconnected(err);
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
    for (const { sentAt } of this.pendingCalls.values()) {
      if (oldest === null || sentAt < oldest) oldest = sentAt;
    }
    for (const sentAt of this.pendingResyncs.values()) {
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
  private _rpcStalled(): boolean {
    const oldest = this._oldestPendingAt();
    if (oldest === null) return false;
    if (Date.now() - oldest < this.watchdogStaleMs) return false;
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
        const delay = Math.max(oldest + this.watchdogStaleMs - Date.now(), 50);
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
      pendingCallCount: this.pendingCalls.size + this.pendingResyncs.size,
      msSinceOldestPendingCall:
        oldestPending === null ? null : Date.now() - oldestPending,
    };
  }

  // ── Hello / resync handshake ─────────────────────────────────────

  private _handshake(): Promise<void> {
    this._cancelPendingHandshake();
    this._cancelPendingTermination();
    this.lastHelloAttemptAt = Date.now();
    const handshakeAttempt = ++this.handshakeAttemptGeneration;
    this.sessionBoundaryGeneration++;
    this.sessionReadyForEvents = false;
    const operationGeneration = this.sessionOperationGeneration;
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<typeof HANDSHAKE_CANCELLED>((resolve) => {
      cancel = () => resolve(HANDSHAKE_CANCELLED);
    });
    const pending = { attempt: handshakeAttempt, cancel };
    this.pendingHandshake = pending;
    const result = this._performHandshake(
      operationGeneration,
      handshakeAttempt,
      cancelled,
    ).finally(() => {
      if (this.pendingHandshake === pending) {
        this.pendingHandshake = null;
      }
    });
    this.helloReady = result;
    return result;
  }

  private _cancelPendingHandshake(): void {
    const pending = this.pendingHandshake;
    if (!pending) return;
    this.handshakeAttemptGeneration++;
    this.pendingHandshake = null;
    pending.cancel();
  }

  private _cancelPendingTermination(): void {
    const pending = this.pendingTermination;
    if (!pending) return;
    this.pendingTermination = null;
    pending.cancel();
  }

  private _cancelPendingDataOperations(error: Error): void {
    const calls = [...this.pendingCalls.values()];
    const resyncs = [...this.pendingResyncs.keys()];
    this.inflight.clear();
    for (const { cancel } of calls) cancel(error);
    for (const cancel of resyncs) cancel(error);
  }

  private _cancelPendingConnectionWaits(error: Error): void {
    for (const cancel of [...this.pendingConnectionWaits]) cancel(error);
  }

  private _clearEventAcknowledgements(): void {
    this.pendingEventAcknowledgements.clear();
  }

  private _beginAuthorizationBoundary(): void {
    this._cancelPendingDataOperations(
      new Error("Parcae request cancelled by an authorization boundary"),
    );
    this._cancelPendingConnectionWaits(
      new Error(
        "Parcae connection wait cancelled by an authorization boundary",
      ),
    );
    this._clearEventAcknowledgements();
    this._clearSubscriptions();
    this.authorizationGeneration++;
    this.sessionBoundaryGeneration++;
    this.sessionReadyForEvents = false;
    this.session.beginReconciliation();
  }

  private async _emitHello(
    token: string | null,
    cancelled: Promise<typeof HANDSHAKE_CANCELLED>,
  ): Promise<any | typeof HANDSHAKE_CANCELLED> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const acknowledgement = new Promise<any>((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Parcae hello timeout")),
        DEFAULT_TIMEOUT,
      );
      this.socket.emit("hello", { token }, resolve);
    });

    try {
      return await Promise.race([acknowledgement, cancelled]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }

  private async _performHandshake(
    operationGeneration: number,
    handshakeAttempt: number,
    cancelled: Promise<typeof HANDSHAKE_CANCELLED>,
  ): Promise<void> {
    if (
      operationGeneration !== this.sessionOperationGeneration ||
      handshakeAttempt !== this.handshakeAttemptGeneration
    ) {
      return;
    }

    // A reconnect after explicit sign-out must never consult the previously
    // installed resolver. The disconnected server-side socket is already gone;
    // bind the new socket anonymously and keep the machine terminated until an
    // explicit refreshSession() begins a new sign-in.
    if (this.session.state.status === "terminated") {
      await this._emitHello(null, cancelled);
      return;
    }

    const resolverRevision = this.tokenResolverRevision;
    const getToken = this.getToken;
    const tokenResult = getToken().then(
      (token) => ({ kind: "token" as const, token }),
      (error) => ({ kind: "error" as const, error }),
    );
    const resolvedToken = await Promise.race([tokenResult, cancelled]);
    if (resolvedToken === HANDSHAKE_CANCELLED) return;
    if (resolvedToken.kind === "error") {
      const error =
        resolvedToken.error instanceof Error
          ? resolvedToken.error
          : new Error(String(resolvedToken.error));
      log.warn("hello: token resolution failed");
      this.emit("error", error);
      // Keep SessionMachine pending / unchanged. A failed token read is
      // not proof of an anonymous session; it usually means the auth
      // endpoint is temporarily unavailable (502/CORS during backend
      // restart). Treating it as null would fire protected queries as
      // :anon: and turn transient infra failure into 403 storms.
      throw error;
    }
    const token = resolvedToken.token;

    // Sign-out invalidates token resolution already in flight. Never emit a
    // token obtained before the termination boundary.
    if (
      operationGeneration !== this.sessionOperationGeneration ||
      handshakeAttempt !== this.handshakeAttemptGeneration
    ) {
      return;
    }

    const t0 = performance.now();
    const response = await this._emitHello(token, cancelled);
    if (
      response === HANDSHAKE_CANCELLED ||
      operationGeneration !== this.sessionOperationGeneration ||
      handshakeAttempt !== this.handshakeAttemptGeneration
    ) {
      return;
    }
    if (response?.stale === true) {
      throw new Error("Parcae hello was superseded before reconciliation");
    }

    const ms = (performance.now() - t0).toFixed(0);
    const userId = response?.userId ?? null;
    const previousStatus = this.session.state.status;
    const previousUserId = this.session.state.userId;
    log.debug(`hello: ${userId ? "authenticated" : "anonymous"} (${ms}ms)`);
    if (this.hasResolvedSession && previousStatus === "pending") {
      // A session listener can run re-entrantly from beginReconciliation().
      // Any raw subscription registered in that pending window belongs to no
      // confirmed owner and must not become active for this hello result.
      this._clearSubscriptions();
    }
    if (previousStatus !== "pending" && previousUserId !== userId) {
      this._clearEventAcknowledgements();
      this._clearSubscriptions();
      this.authorizationGeneration++;
    }
    this.lastHelloAckAt = Date.now();
    this.session.resolve(userId);
    this.hasResolvedSession = true;
    this.confirmedHelloToken = token;
    // Session listeners run synchronously and may start a newer refresh or
    // terminate the session. The superseded hello must not reopen raw events,
    // mark its resolver reconciled, or publish a resync signal afterward.
    if (
      operationGeneration !== this.sessionOperationGeneration ||
      handshakeAttempt !== this.handshakeAttemptGeneration
    ) {
      return;
    }
    this.sessionReadyForEvents = true;
    this.reconciledTokenResolverRevision = resolverRevision;
    this._scheduleWatchdog();
    // Resync runs after every successful hello. Consumers track
    // their own cache state and decide whether they have anything
    // to ask the server about; the transport just publishes the
    // signal once per handshake.
    this.emit("resync-required");
  }

  /**
   * Resync RPC. Used by `useQuery` after every reconnect to
   * re-establish server-side query subscriptions in a single round
   * trip. Returns the freshly-evaluated results for every entry.
   */
  async resync(entries: ResyncEntry[]): Promise<ResyncResult[]> {
    if (entries.length === 0) return [];
    await this.helloReady;
    if (
      !this.sessionReadyForEvents ||
      this.session.state.status === "terminated"
    ) {
      throw new Error("Parcae resync requires a reconciled session");
    }
    const operationGeneration = this.sessionOperationGeneration;
    const boundaryGeneration = this.sessionBoundaryGeneration;
    const resolverRevision = this.tokenResolverRevision;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (
        outcome:
          | { status: "resolved"; value: ResyncResult[] }
          | { status: "rejected"; error: Error },
      ) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this.pendingResyncs.delete(cancel);
        if (outcome.status === "resolved") resolve(outcome.value);
        else reject(outcome.error);
      };
      const cancel = (error: Error) => finish({ status: "rejected", error });
      this.pendingResyncs.set(cancel, Date.now());
      this._scheduleWatchdog();
      timeout = setTimeout(() => {
        cancel(new Error("resync timeout"));
      }, DEFAULT_TIMEOUT);
      this.socket.emit("resync", { queries: entries }, (response: any) => {
        this._noteRpcResponse();
        if (settled) return;
        if (
          operationGeneration !== this.sessionOperationGeneration ||
          boundaryGeneration !== this.sessionBoundaryGeneration ||
          resolverRevision !== this.tokenResolverRevision
        ) {
          cancel(
            new Error("Parcae resync response discarded after session change"),
          );
          return;
        }
        if (response?.success === false) {
          cancel(new Error(response?.error || "resync failed"));
          return;
        }
        finish({ status: "resolved", value: response?.results ?? [] });
      });
    });
  }

  // ── Public API ───────────────────────────────────────────────────

  get needsSessionRefresh(): boolean {
    return this.reconciledTokenResolverRevision < this.tokenResolverRevision;
  }

  updateTokenResolver(getToken: () => Promise<string | null>): void {
    if (this.tokenResolverLease) {
      throw new Error("Parcae token resolver is owned by an active Provider");
    }
    this._replaceTokenResolver(getToken, true);
  }

  get hasTokenResolverLease(): boolean {
    return this.tokenResolverLease !== null;
  }

  acquireTokenResolverLease(
    lease: object,
    getToken: () => Promise<string | null>,
  ): void {
    if (this.tokenResolverLease && this.tokenResolverLease !== lease) {
      throw new Error(
        "Parcae token resolver is owned by another active Provider",
      );
    }
    const sameLease = this.tokenResolverLease === lease;
    this.tokenResolverLease = lease;
    this._replaceTokenResolver(
      getToken,
      !sameLease || this.getToken !== getToken,
    );
  }

  releaseTokenResolverLease(lease: object): boolean {
    if (this.tokenResolverLease === lease) {
      this.tokenResolverLease = null;
      // The globally cached client outlives its Provider. Drop the resolver
      // closure immediately so the unmounted auth adapter/token state cannot
      // remain strongly reachable through this transport.
      this._replaceTokenResolver(ANONYMOUS_TOKEN_RESOLVER, true);
      return true;
    }
    return false;
  }

  private _replaceTokenResolver(
    getToken: () => Promise<string | null>,
    forceReconciliation: boolean,
  ): void {
    if (!forceReconciliation && this.getToken === getToken) return;
    this._cancelPendingHandshake();
    this._cancelPendingTermination();
    this.getToken = getToken;
    this.tokenResolverRevision++;
    this._beginAuthorizationBoundary();
  }

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
    // A caller-requested refresh is an authorization boundary even when the
    // resolver function and resulting user id are unchanged (for example an
    // organization/role change carried by a rotated token).
    this._cancelPendingHandshake();
    this._cancelPendingTermination();
    this._beginAuthorizationBoundary();
    return this._refreshSession(true);
  }

  /** Wait for the latest resolver/hello boundary without creating a new one. */
  async awaitSessionReconciled(): Promise<{ userId: string | null }> {
    return this._refreshSession(false);
  }

  private async _refreshSession(
    allowTerminatedReset: boolean,
  ): Promise<{ userId: string | null }> {
    const operationGeneration = this.sessionOperationGeneration;
    if (this.session.state.status === "terminated") {
      if (!allowTerminatedReset) {
        throw new Error("Parcae session is terminated");
      }
      this.session.reset();
    }

    const assertOperationActive = () => {
      if (
        operationGeneration !== this.sessionOperationGeneration ||
        this.session.state.status === "terminated"
      ) {
        throw new Error("Parcae session was terminated during reconciliation");
      }
    };

    while (true) {
      assertOperationActive();
      if (!this.socket.connected) {
        await this._waitForConnection();
        continue;
      }

      if (
        this.sessionReadyForEvents &&
        this.session.state.status !== "pending" &&
        this.session.state.status !== "terminated" &&
        !this.needsSessionRefresh &&
        this.pendingHandshake === null
      ) {
        return { userId: this.session.state.userId };
      }

      const reconciliation =
        this.pendingHandshake === null ? this._handshake() : this.helloReady;
      await reconciliation;
    }
  }

  private async _waitForConnection(): Promise<void> {
    if (this.socket.connected) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(() =>
          reject(new Error("Parcae connection timeout during reconciliation")),
        );
      }, DEFAULT_TIMEOUT);
      const cancel = (error: Error) => finish(() => reject(error));
      const onConnect = () => {
        finish(resolve);
      };
      const onError = (error: Error) => {
        finish(() => reject(error));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.socket.off("connect", onConnect);
        this.socket.off("connect_error", onError);
        this.pendingConnectionWaits.delete(cancel);
      };
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        settle();
      };
      this.pendingConnectionWaits.add(cancel);
      this.socket.once("connect", onConnect);
      this.socket.once("connect_error", onError);
      this.socket.connect();
    });
  }

  /** The token the server last validated at hello, null before the first
   * authenticated hello and after sign-out. The authorization baseline for
   * rotation comparisons: it can never run ahead of the server session. */
  lastConfirmedToken(): string | null {
    return this.confirmedHelloToken;
  }

  /** Explicit sign-out. Marks the session terminated and drops the socket auth. */
  async terminateSession(): Promise<void> {
    this._cancelPendingHandshake();
    this._cancelPendingTermination();
    this._clearEventAcknowledgements();
    this._clearSubscriptions();
    this.sessionOperationGeneration++;
    this.sessionBoundaryGeneration++;
    this.authorizationGeneration++;
    this.sessionReadyForEvents = false;
    this.confirmedHelloToken = null;
    this._cancelPendingDataOperations(
      new Error("Parcae request cancelled because the session terminated"),
    );
    this._cancelPendingConnectionWaits(
      new Error(
        "Parcae reconciliation cancelled because the session terminated",
      ),
    );
    this.session.terminate();
    this._scheduleWatchdog();
    if (!this.socket.connected) {
      this.helloReady = Promise.resolve();
      return;
    }

    const operation = this.sessionOperationGeneration;
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<typeof HANDSHAKE_CANCELLED>((resolve) => {
      cancel = () => resolve(HANDSHAKE_CANCELLED);
    });
    const pending = { operation, cancel };
    this.pendingTermination = pending;
    const termination = this._emitHello(null, cancelled)
      .then(() => undefined)
      .finally(() => {
        if (this.pendingTermination === pending) {
          this.pendingTermination = null;
        }
      });
    this.helloReady = termination;
    await termination;
  }

  get isConnected(): boolean {
    return this.connection.state.status === "connected";
  }

  // ── Request/Response ─────────────────────────────────────────────

  private async fetch(
    method: string,
    path: string,
    data: any = {},
    options?: RequestOptions,
  ): Promise<any> {
    const requestSessionGeneration = this.sessionOperationGeneration;
    const requestAuthorizationGeneration = this.authorizationGeneration;
    const assertRequestSessionActive = () => {
      if (
        requestSessionGeneration !== this.sessionOperationGeneration ||
        requestAuthorizationGeneration !== this.authorizationGeneration ||
        this.session.state.status === "terminated"
      ) {
        throw new Error(
          "Parcae authorization changed before the RPC could be sent",
        );
      }
    };

    assertRequestSessionActive();

    // Always pass through the full readiness gate. `needsSessionRefresh`
    // alone is insufficient: an explicit same-resolver refresh marks the
    // session pending before installing its next hello promise, and a
    // synchronous session listener can re-enter `get()` in that interval.
    // `_refreshSession` observes `sessionReadyForEvents` and starts/joins the
    // current hello before this RPC is allowed onto the wire.
    let cancelReadiness: (error: Error) => void = () => undefined;
    const readinessCancelled = new Promise<never>((_resolve, reject) => {
      cancelReadiness = reject;
    });
    this.pendingConnectionWaits.add(cancelReadiness);
    try {
      await Promise.race([this._refreshSession(false), readinessCancelled]);
    } finally {
      this.pendingConnectionWaits.delete(cancelReadiness);
    }
    assertRequestSessionActive();

    const upper = method.toUpperCase();
    if (upper === "GET") {
      const dedupeKey =
        `${this.sessionOperationGeneration}:` +
        `${this.sessionBoundaryGeneration}:${path}:` +
        JSON.stringify(data);
      const existing = this.inflight.get(dedupeKey);
      if (existing) return existing;
      const req = this._call(method, path, data, options);
      this.inflight.set(dedupeKey, req);
      req.then(
        () => {
          if (this.inflight.get(dedupeKey) === req) {
            this.inflight.delete(dedupeKey);
          }
        },
        () => {
          if (this.inflight.get(dedupeKey) === req) {
            this.inflight.delete(dedupeKey);
          }
        },
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
    const callSessionOperationGeneration = this.sessionOperationGeneration;
    const callSessionBoundaryGeneration = this.sessionBoundaryGeneration;
    const callTokenResolverRevision = this.tokenResolverRevision;
    const id = uid.rnd();
    const t0 = performance.now();
    const timeoutMs = options?.timeout ?? DEFAULT_TIMEOUT;
    log.debug(`RPC ${method.toUpperCase()}: sent`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (
        outcome:
          | { status: "resolved"; value: unknown }
          | { status: "rejected"; error: unknown },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.socket.off(id, onResponse);
        this.pendingCalls.delete(id);
        this._scheduleWatchdog();
        if (outcome.status === "resolved") resolve(outcome.value);
        else reject(outcome.error);
      };
      const cancel = (error: Error) => finish({ status: "rejected", error });
      const timeout = setTimeout(() => {
        log.debug(
          `RPC ${method.toUpperCase()}: timeout (${(timeoutMs / 1000).toFixed(0)}s)`,
        );
        cancel(new Error(`RPC timeout: ${method} ${path}`));
      }, timeoutMs);

      const onResponse = (msg: any) => {
        // Any response frame proves the wire is alive, even one a
        // session boundary is about to discard.
        this._noteRpcResponse();
        if (
          callSessionOperationGeneration !== this.sessionOperationGeneration ||
          callSessionBoundaryGeneration !== this.sessionBoundaryGeneration ||
          callTokenResolverRevision !== this.tokenResolverRevision
        ) {
          cancel(
            new Error(
              `RPC response discarded after Parcae session changed: ${method} ${path}`,
            ),
          );
          return;
        }
        const ms = (performance.now() - t0).toFixed(0);
        try {
          const uncompressed = pako.ungzip(msg, { to: "string" });
          const parsed = decompress(JSON.parse(uncompressed));
          if (parsed.success) {
            log.debug(`RPC ${method.toUpperCase()}: success (${ms}ms)`);
            finish({ status: "resolved", value: parsed.result });
          } else {
            log.debug(`RPC ${method.toUpperCase()}: rejected (${ms}ms)`);
            finish({
              status: "rejected",
              error: new Error(
                parsed.message || parsed.error || `${method} ${path} failed`,
              ),
            });
          }
        } catch (err) {
          log.debug(`RPC ${method.toUpperCase()}: parse error (${ms}ms)`);
          finish({ status: "rejected", error: err });
        }
      };

      this.pendingCalls.set(id, { cancel, sentAt: Date.now() });
      this.socket.once(id, onResponse);
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
    if (
      this.session.state.status === "terminated" ||
      (this.hasResolvedSession &&
        (!this.sessionReadyForEvents ||
          this.needsSessionRefresh ||
          this.session.state.status === "pending"))
    ) {
      throw new Error("Parcae raw subscriptions require a reconciled session");
    }

    let eventSubscriptions = this.subscriptions.get(event);
    if (!eventSubscriptions) {
      eventSubscriptions = new Map();
      this.subscriptions.set(event, eventSubscriptions);
    }

    const existing = eventSubscriptions.get(handler);
    if (existing) {
      this.socket.off(event, existing.wrapper);
    }

    const subscription = {
      authorization: this.authorizationGeneration,
      wrapper: (...args: any[]) => {
        if (
          this.sessionReadyForEvents &&
          !this.needsSessionRefresh &&
          subscription.authorization === this.authorizationGeneration
        ) {
          handler(...args);
        }
      },
    };
    eventSubscriptions.set(handler, subscription);
    this.socket.on(event, subscription.wrapper);

    return () => {
      this.socket.off(event, subscription.wrapper);
      if (eventSubscriptions?.get(handler) === subscription) {
        eventSubscriptions.delete(handler);
        if (eventSubscriptions.size === 0) {
          this.subscriptions.delete(event);
        }
      }
    };
  }

  private _clearSubscriptions(): void {
    for (const [event, eventSubscriptions] of this.subscriptions) {
      for (const { wrapper } of eventSubscriptions.values()) {
        this.socket.off(event, wrapper);
      }
    }
    this.subscriptions.clear();
  }

  unsubscribe(event: string, handler?: (...args: any[]) => void): void {
    const eventSubscriptions = this.subscriptions.get(event);
    if (!handler) {
      if (!eventSubscriptions) return;
      for (const { wrapper } of eventSubscriptions.values()) {
        this.socket.off(event, wrapper);
      }
      this.subscriptions.delete(event);
      return;
    }

    const subscription = eventSubscriptions?.get(handler);
    if (!subscription) return;
    this.socket.off(event, subscription.wrapper);
    eventSubscriptions?.delete(handler);
    if (eventSubscriptions?.size === 0) {
      this.subscriptions.delete(event);
    }
  }

  send(event: string, ...args: any[]): void {
    if (
      !this.socket.connected ||
      !this.sessionReadyForEvents ||
      this.needsSessionRefresh ||
      this.session.state.status === "pending" ||
      this.session.state.status === "terminated"
    ) {
      throw new Error(
        "Parcae raw events require a connected, reconciled session",
      );
    }
    const guardedArgs = [...args];
    const acknowledgement = guardedArgs.at(-1);
    let acknowledgementId: symbol | null = null;
    if (typeof acknowledgement === "function") {
      acknowledgementId = Symbol("socket-event-ack");
      const authorizationGeneration = this.authorizationGeneration;
      this.pendingEventAcknowledgements.set(acknowledgementId, acknowledgement);
      guardedArgs[guardedArgs.length - 1] = (...ackArgs: any[]) => {
        const active = this.pendingEventAcknowledgements.get(
          acknowledgementId!,
        );
        this.pendingEventAcknowledgements.delete(acknowledgementId!);
        if (
          active &&
          authorizationGeneration === this.authorizationGeneration &&
          this.sessionReadyForEvents &&
          !this.needsSessionRefresh
        ) {
          active(...ackArgs);
        }
      };
    }

    try {
      const emitted = this.socket.emit(event, ...guardedArgs);
      if (!emitted && acknowledgementId) {
        this.pendingEventAcknowledgements.delete(acknowledgementId);
      }
    } catch (error) {
      if (acknowledgementId) {
        this.pendingEventAcknowledgements.delete(acknowledgementId);
      }
      throw error;
    }
  }

  disconnect(): void {
    this.watchdogSuspended = true;
    this._cancelPendingDataOperations(
      new Error("Parcae client disconnected during request"),
    );
    this._cancelPendingConnectionWaits(
      new Error("Parcae client disconnected during reconciliation"),
    );
    this._clearEventAcknowledgements();
    this.socket.disconnect();
    this._scheduleWatchdog();
  }

  async reconnect(): Promise<void> {
    this.watchdogSuspended = false;
    if (this.socket.connected) {
      this._scheduleWatchdog();
      return;
    }
    this.connection.connecting();
    this.socket.connect();
    this._scheduleWatchdog();
  }
}
