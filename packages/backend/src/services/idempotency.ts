/**
 * @parcae/backend — Idempotency
 *
 * A write with an `idempotency-key` header, from a signed-in user, runs once per key. One Redis key
 * holds first a claim, for as long as a call may run, then the first answer, whatever its status,
 * for a day. Nothing frees a claim: once a write has started, its work may already be done.
 */

import { NOT_RUN, REQUEST_TIMEOUT_MS, IDEMPOTENCY_TTL_MS } from "@parcae/model";

import { log } from "../logger";
import { json } from "../helpers";
import type { PubSub } from "./pubsub";

/**
 * A repeat gets the first answer, or 409 `NOT_RUN` while the first still runs. A write that
 * runs past REQUEST_TIMEOUT_MS, or a server that dies after saving but before answering, can run
 * twice.
 */
export function createIdempotencyMiddleware(
  pubsub: PubSub,
): (req: any, res: any, next: () => void) => Promise<void> {
  return async (req, res, next) => {
    const key = req.headers?.["idempotency-key"];
    const user = req.session?.user?.id;
    if (req.method === "GET" || typeof key !== "string" || !key || !user) return next();
    const slot = `parcae:write:${user}:${key}`;
    const name = `${req.method} ${req.path ?? req.url}`;

    if (!(await pubsub.tryLock(slot, REQUEST_TIMEOUT_MS))) {
      const stored = await pubsub.recall(slot);
      if (stored && stored !== "1") {
        const { status, body } = JSON.parse(stored) as { status: number; body: string };
        log.info(`[idempotency] ${name} repeat answered ${status} from memory`);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
        return;
      }
      log.info(`[idempotency] ${name} repeat refused, first still running`);
      json(res, 409, { result: null, success: false, error: "This write is still running", code: NOT_RUN });
      return;
    }

    // Every answer, the socket's catch path included, leaves through `res.end`.
    const end = res.end;
    res.end = function (body?: unknown, ...rest: unknown[]) {
      res.end = end;
      const answer = JSON.stringify({ status: res.statusCode, body: body == null ? "" : String(body) });
      pubsub.remember(slot, answer, IDEMPOTENCY_TTL_MS).catch((err) => {
        log.warn(`[idempotency] ${name} answer not kept:`, err);
      });
      return end.call(res, body, ...rest);
    };
    next();
  };
}
