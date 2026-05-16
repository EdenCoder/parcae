/**
 * ChangeBus — cross-process model-change bus tests.
 *
 * Uses the in-process PubSub fallback (no Redis URL), which delivers
 * events via a local EventEmitter. That's enough to validate the
 * publish/subscribe wiring AND the dedup logic — Redis paths are
 * covered by the integration suite when REDIS_URL is set.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChangeBus, type Change } from "../services/changeBus";
import { PubSub } from "../services/pubsub";

describe("ChangeBus", () => {
  let pubsub: PubSub;
  let bus: ChangeBus;

  beforeEach(() => {
    pubsub = new PubSub();
    bus = new ChangeBus({ pubsub });
  });

  afterEach(async () => {
    bus.close();
    await pubsub.close();
  });

  function makeChange(overrides: Partial<Change> = {}): Change {
    return {
      table: "posts",
      op: "update",
      id: "p1",
      requestId: "req_test",
      source: "hook",
      ...overrides,
    };
  }

  it("delivers a hook-emit to a local listener", async () => {
    const received: Change[] = [];
    bus.on((c) => received.push(c));
    bus.emit(makeChange());
    // The in-process PubSub path is synchronous via EventEmitter, so
    // the listener fires before this microtask yields. A trivial
    // `await Promise.resolve()` keeps the assertion future-proof
    // against a Redis-path async edge.
    await Promise.resolve();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      table: "posts",
      op: "update",
      id: "p1",
      source: "hook",
    });
  });

  it("drops a LISTEN echo of a hook emit (same requestId)", async () => {
    const received: Change[] = [];
    bus.on((c) => received.push(c));

    // Hook-path emit registers requestId in the dedup window.
    bus.emit(makeChange({ requestId: "req_hook_1", source: "hook" }));
    // The corresponding LISTEN echo should be dropped.
    bus.emit(makeChange({ requestId: "req_hook_1", source: "listen" }));

    await Promise.resolve();
    expect(received).toHaveLength(1);
    expect(received[0]!.source).toBe("hook");
  });

  it("delivers a LISTEN emit with no matching hook requestId", async () => {
    const received: Change[] = [];
    bus.on((c) => received.push(c));

    // External writer never went through the hook path. LISTEN
    // should deliver this event since the requestId isn't on file.
    bus.emit(
      makeChange({ requestId: "req_external", source: "listen" }),
    );

    await Promise.resolve();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      table: "posts",
      op: "update",
      id: "p1",
      source: "listen",
    });
  });

  it("delivers two LISTEN events for unrelated requestIds", async () => {
    const received: Change[] = [];
    bus.on((c) => received.push(c));

    bus.emit(makeChange({ requestId: "rid_a", source: "listen" }));
    bus.emit(makeChange({ requestId: "rid_b", source: "listen" }));

    await Promise.resolve();
    expect(received).toHaveLength(2);
  });

  it("does NOT dedup the hook emit against an earlier hook emit", async () => {
    // Each hook emit is authoritative — the bus must never drop one
    // of its own emits. Two distinct hook writes with the same id
    // (e.g. a save + immediate patch) get TWO downstream re-evals.
    const received: Change[] = [];
    bus.on((c) => received.push(c));

    bus.emit(makeChange({ requestId: "rid_x", source: "hook" }));
    bus.emit(makeChange({ requestId: "rid_x", source: "hook" }));

    await Promise.resolve();
    expect(received).toHaveLength(2);
  });

  it("supports multiple listeners and isolated errors", async () => {
    const a: Change[] = [];
    const b: Change[] = [];
    bus.on((c) => {
      a.push(c);
      throw new Error("listener a should not break b");
    });
    bus.on((c) => b.push(c));

    bus.emit(makeChange());
    await Promise.resolve();

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("on() returns an unsubscribe that detaches the listener", async () => {
    const received: Change[] = [];
    const off = bus.on((c) => received.push(c));

    bus.emit(makeChange());
    await Promise.resolve();
    expect(received).toHaveLength(1);

    off();
    bus.emit(makeChange());
    await Promise.resolve();
    expect(received).toHaveLength(1);
  });

  it("newRequestId returns unique tagged ids", () => {
    const a = bus.newRequestId();
    const b = bus.newRequestId();
    expect(a).not.toEqual(b);
    expect(a.startsWith("req_")).toBe(true);
    expect(b.startsWith("req_")).toBe(true);
  });

  it("LISTEN echo arriving AFTER the dedup window expires is delivered", async () => {
    const shortBus = new ChangeBus({
      pubsub,
      dedupTtlMs: 10,
    });
    const received: Change[] = [];
    shortBus.on((c) => received.push(c));

    shortBus.emit(
      makeChange({ requestId: "rid_short", source: "hook" }),
    );
    expect(received).toHaveLength(1);

    // Wait past the dedup window.
    await new Promise((r) => setTimeout(r, 30));

    shortBus.emit(
      makeChange({ requestId: "rid_short", source: "listen" }),
    );
    expect(received).toHaveLength(2);
    expect(received[1]!.source).toBe("listen");

    shortBus.close();
  });
});
