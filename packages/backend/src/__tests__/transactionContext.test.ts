/**
 * Transaction context tests — withTransaction(), buffer flush on
 * commit, buffer discard on rollback, nested calls.
 *
 * Uses a stub knex instance so we don't need a real DB up. The stub
 * lets us drive commit/rollback paths deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChangeBus, type Change } from "../services/changeBus";
import { PubSub } from "../services/pubsub";
import {
  bufferChangeIfActive,
  getActiveTransactionFrame,
  withTransaction,
} from "../services/transactionContext";

// ─── Stub knex.transaction ───────────────────────────────────────────────────

/**
 * Minimum-viable knex stub. `transaction(fn)` resolves with whatever
 * `fn(trx)` returns and rejects (rolls back) if `fn` throws — same
 * contract as real knex. The `raw` method is a no-op so the
 * setRequestIdGuc branch doesn't break under the stub.
 */
function makeStubKnex() {
  const raw = vi.fn(async (_sql: string, _bindings?: any[]) => undefined);
  const trx: any = { raw };
  return {
    raw,
    transaction: async (fn: (t: any) => Promise<any>) => {
      // Run fn; whatever it returns becomes the result. If fn throws,
      // re-throw so the caller treats it as a rollback (same as real
      // knex.transaction).
      return await fn(trx);
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("withTransaction", () => {
  let pubsub: PubSub;
  let bus: ChangeBus;
  let received: Change[];

  beforeEach(() => {
    pubsub = new PubSub();
    bus = new ChangeBus({ pubsub });
    received = [];
    bus.on((c) => received.push(c));
  });

  afterEach(async () => {
    bus.close();
    await pubsub.close();
  });

  function fakeChange(overrides: Partial<Change> = {}): Change {
    return {
      table: "posts",
      op: "update",
      id: "p1",
      requestId: "req_default",
      source: "hook",
      ...overrides,
    };
  }

  it("opens a frame that buffers Changes via bufferChangeIfActive", async () => {
    expect(getActiveTransactionFrame()).toBeNull();

    const knex = makeStubKnex();
    await withTransaction({ knex, changeBus: bus }, async () => {
      const frame = getActiveTransactionFrame();
      expect(frame).not.toBeNull();
      // Buffering inside the frame returns true and adds to the
      // frame buffer — bus shouldn't see anything yet.
      const buffered = bufferChangeIfActive(
        fakeChange({ requestId: frame!.requestId }),
      );
      expect(buffered).toBe(true);
      expect(received).toHaveLength(0);
    });
    // Frame is closed, change has flushed.
    expect(getActiveTransactionFrame()).toBeNull();
    expect(received).toHaveLength(1);
  });

  it("flushes buffered Changes in order on commit", async () => {
    const knex = makeStubKnex();
    await withTransaction({ knex, changeBus: bus }, async () => {
      bufferChangeIfActive(fakeChange({ id: "1" }));
      bufferChangeIfActive(fakeChange({ id: "2" }));
      bufferChangeIfActive(fakeChange({ id: "3" }));
      expect(received).toHaveLength(0);
    });
    expect(received.map((c) => c.id)).toEqual(["1", "2", "3"]);
  });

  it("discards the buffer when the callback throws", async () => {
    const knex = makeStubKnex();
    await expect(
      withTransaction({ knex, changeBus: bus }, async () => {
        bufferChangeIfActive(fakeChange({ id: "ghost" }));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(received).toHaveLength(0);
  });

  it("nested calls share the same frame and request-id", async () => {
    const knex = makeStubKnex();
    let outerRid: string | undefined;
    let innerRid: string | undefined;

    await withTransaction({ knex, changeBus: bus }, async () => {
      outerRid = getActiveTransactionFrame()!.requestId;
      bufferChangeIfActive(
        fakeChange({ id: "outer", requestId: outerRid }),
      );
      await withTransaction({ knex, changeBus: bus }, async () => {
        innerRid = getActiveTransactionFrame()!.requestId;
        bufferChangeIfActive(
          fakeChange({ id: "inner", requestId: innerRid }),
        );
      });
      // After the inner exits, frame still exists with depth back at 1.
      expect(getActiveTransactionFrame()).not.toBeNull();
    });

    expect(outerRid).toBe(innerRid);
    expect(received.map((c) => c.id)).toEqual(["outer", "inner"]);
  });

  it("issues a SET LOCAL parcae.request_id when setRequestIdGuc=true", async () => {
    const knex = makeStubKnex();
    let observedRid: string | undefined;
    await withTransaction(
      { knex, changeBus: bus, setRequestIdGuc: true, requestId: "rid_custom" },
      async () => {
        observedRid = getActiveTransactionFrame()!.requestId;
      },
    );
    expect(observedRid).toBe("rid_custom");
    // The stub's raw method should have been called with the
    // set_config statement and the custom request-id binding.
    const calls = (knex.raw as any).mock.calls as any[];
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]![0]).toContain("set_config");
    expect(calls[0]![1]).toEqual(["rid_custom"]);
  });

  it("uses changeBus.newRequestId() when no requestId is passed", async () => {
    const knex = makeStubKnex();
    let observedRid: string | undefined;
    await withTransaction({ knex, changeBus: bus }, async () => {
      observedRid = getActiveTransactionFrame()!.requestId;
    });
    expect(observedRid).toBeDefined();
    expect(observedRid!.startsWith("req_")).toBe(true);
  });

  it("bufferChangeIfActive returns false outside any frame", () => {
    const buffered = bufferChangeIfActive(fakeChange());
    expect(buffered).toBe(false);
  });
});
