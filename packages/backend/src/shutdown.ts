/**
 * Graceful shutdown for the @parcae/backend app.
 *
 * `app.stop()` (in `./app.ts`) collects every long-lived resource that
 * `app.start()` opened — Socket.IO + HTTP server, BullMQ workers via the
 * `QueueService`, PubSub Redis clients, Knex pools, cron timers, the
 * Postgres change bus — and hands them
 * here. We tear them down in a specific order:
 *
 *   1. Stop accepting new HTTP and WebSocket connections.
 *      (`io.close()` then await `httpServer.close()`)
 *   2. Stop schedulers and change-bus fan-out.
 *      Cron handlers continue to completion in-flight but won't tick
 *      again. The change bus closes its dedicated LISTEN connection and
 *      removes local listeners.
 *   3. Drain BullMQ workers with a bounded timeout.
 *      `queue.close()` waits for in-flight jobs to finish before it
 *      resolves; if a job is misbehaving we cap the wait so the process
 *      isn't held hostage. Any waiting time after the cap is wasted
 *      anyway — the workers will be SIGKILLed shortly.
 *   4. Close PubSub Redis clients.
 *      Done after queue drain because BullMQ's distributed coordination
 *      uses the same Redis instance; closing pubsub first can cause
 *      spurious "connection lost" errors during the drain.
 *   5. Destroy Knex pools.
 *      Done last because in-flight hooks/jobs may still need DB access
 *      during the drain. If `readDb === writeDb` (no read replica) we
 *      only destroy once.
 *
 * Errors at any step are caught and logged but never propagated. A slow
 * Redis disconnect must not prevent the DB pool from closing, etc. The
 * goal is to give every resource its best chance to clean up cleanly,
 * then exit.
 */

import type { Server as SocketServer } from "socket.io";
import type { Knex } from "knex";
import type { AuthAdapter } from "./auth";
import { log } from "./logger";
import type { ChangeBus } from "./services/change-bus";
import type { PubSub } from "./services/pubsub";
import type { QueueService } from "./services/queue";

// Cron is the `cron` npm package's class — we only need .stop() here.
interface CronLike {
  stop(): void;
}

// Node's http.Server — only needs .close(cb).
interface HttpServerLike {
  close(cb?: (err?: Error) => void): void;
}

export interface ShutdownResources {
  /** Socket.IO server. Closed before the underlying http server. */
  io?: SocketServer | null;
  /** Node's http.Server. Awaited via its close callback. */
  httpServer?: HttpServerLike | null;
  /** Cron schedulers started by app.start(). Each .stop() is best-effort. */
  crons?: CronLike[] | null;
  /** Postgres-native change bus. Owns a dedicated LISTEN connection. */
  changeBus?: ChangeBus | null;
  /** BullMQ workers + queues. Drained with `drainTimeoutMs` cap. */
  queue?: QueueService | null;
  /** PubSub Redis clients (3 connections: read, write, lock). */
  pubsub?: PubSub | null;
  /** Optional auth-owned resources, such as Better Auth's pg pool. */
  auth?: AuthAdapter | null;
  /** Write-side Knex pool. */
  writeDb?: Knex | null;
  /** Read-side Knex pool. Only destroyed if distinct from writeDb. */
  readDb?: Knex | null;
  /**
   * Maximum time (ms) to wait for the BullMQ queue to drain in-flight
   * jobs. Defaults to 8s, comfortably below Cloud Run's 10s SIGKILL
   * window. Set to 0 to drain without timeout.
   */
  drainTimeoutMs?: number;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 8_000;

/**
 * Run an async cleanup step, catching any thrown error and logging a
 * warning. We never want one slow Redis to block the rest of shutdown.
 */
async function safe(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn(`shutdown: ${label} threw — ${String(err)}`);
  }
}

/**
 * Tear down every resource the parcae app holds open. Idempotent: passing
 * a resource that's already been closed (or null/undefined) is a no-op.
 */
export async function shutdownResources(r: ShutdownResources): Promise<void> {
  // ── 1. Stop accepting new connections ────────────────────────────
  if (r.io) {
    await safe(
      "io.close",
      () =>
        new Promise<void>((resolve) => {
          r.io!.close(() => resolve());
        }),
    );
  }
  if (r.httpServer) {
    await safe(
      "httpServer.close",
      () =>
        new Promise<void>((resolve) => {
          r.httpServer!.close(() => resolve());
        }),
    );
  }

  // ── 2. Stop schedulers + change-bus fan-out ──────────────────────
  if (r.crons?.length) {
    for (const c of r.crons) {
      await safe("cron.stop", () => {
        c.stop();
      });
    }
  }
  if (r.changeBus) {
    await safe("changeBus.stop", () => r.changeBus!.stop());
  }

  // ── 3. Drain BullMQ workers (bounded) ────────────────────────────
  if (r.queue) {
    const timeoutMs = r.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    if (timeoutMs <= 0) {
      await safe("queue.close", () => r.queue!.close());
    } else {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const outcome = await Promise.race([
        r.queue.close().then(
          () => "closed" as const,
          (error: unknown) => ({ error }),
        ),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (outcome === "timeout") {
        log.warn(`shutdown: queue drain timed out after ${timeoutMs}ms`);
        await safe("queue.forceClose", () => r.queue!.forceClose());
      } else if (typeof outcome === "object") {
        log.warn(`shutdown: queue.close threw — ${String(outcome.error)}`);
      }
    }
  }

  // ── 4. Close PubSub Redis clients ────────────────────────────────
  if (r.pubsub) {
    await safe("pubsub.close", () => r.pubsub!.close());
  }

  if (r.auth?.close) {
    await safe("auth.close", () => r.auth!.close!());
  }

  // ── 5. Destroy Knex pools ────────────────────────────────────────
  const closeWrite = r.writeDb
    ? safe("writeDb.destroy", () => r.writeDb!.destroy())
    : Promise.resolve();
  const closeRead =
    r.readDb && r.readDb !== r.writeDb
      ? safe("readDb.destroy", () => r.readDb!.destroy())
      : Promise.resolve();
  await Promise.all([closeWrite, closeRead]);
}
