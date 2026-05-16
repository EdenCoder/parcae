import { describe, it, expect, beforeEach, vi } from "vitest";
import { ModelChangeBus } from "../services/model-change-bus";

// Minimal PubSub stub: routes emits to ALL subscribers (including the
// originator's own listener) just like the real Redis-backed PubSub
// does, so we exercise the dedup path.
function makeStubPubSub() {
  const handlers = new Map<string, Set<(payload: any) => void>>();
  return {
    emit: vi.fn((event: string, payload: any) => {
      const set = handlers.get(event);
      if (!set) return;
      for (const h of set) h(payload);
    }),
    on: vi.fn((event: string, handler: (payload: any) => void) => {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      return () => set!.delete(handler);
    }),
  };
}

// Minimal subscriptions stub: records onModelChange calls.
function makeStubSubscriptions() {
  const calls: string[] = [];
  return {
    calls,
    onModelChange: vi.fn((type: string) => {
      calls.push(type);
    }),
  };
}

// Helper: connect two stub pubsubs by proxying emits in both directions.
// Models a shared Redis "events" channel with two ioredis subscribers.
function bridge(a: ReturnType<typeof makeStubPubSub>, b: ReturnType<typeof makeStubPubSub>) {
  const originalAEmit = a.emit;
  const originalBEmit = b.emit;
  a.emit = vi.fn((event: string, payload: any) => {
    originalAEmit(event, payload);
    originalBEmit(event, payload);
  });
  b.emit = vi.fn((event: string, payload: any) => {
    originalBEmit(event, payload);
    originalAEmit(event, payload);
  });
}

describe("ModelChangeBus", () => {
  describe("notify()", () => {
    it("calls local subscriptions.onModelChange immediately", () => {
      const pubsub = makeStubPubSub();
      const subs = makeStubSubscriptions();
      const bus = new ModelChangeBus(pubsub as any, subs as any);

      bus.notify("chat-message");

      expect(subs.onModelChange).toHaveBeenCalledWith("chat-message");
      expect(subs.onModelChange).toHaveBeenCalledTimes(1);
    });

    it("emits model:change to pubsub stamped with its originatorId", () => {
      const pubsub = makeStubPubSub();
      const subs = makeStubSubscriptions();
      const bus = new ModelChangeBus(pubsub as any, subs as any);

      bus.notify("chat-message");

      expect(pubsub.emit).toHaveBeenCalledWith("model:change", {
        type: "chat-message",
        originatorId: bus.originatorId,
      });
    });

    it("does not double-fire on originator when its own emit loops back", () => {
      const pubsub = makeStubPubSub();
      const subs = makeStubSubscriptions();
      const bus = new ModelChangeBus(pubsub as any, subs as any);

      bus.notify("chat-message");

      // notify() runs the local fast-path (1 call). The emit loops back
      // through the same pubsub to this bus's own listener, which must
      // skip via originatorId match.
      expect(subs.onModelChange).toHaveBeenCalledTimes(1);
    });

    it("works without pubsub (Redis-down fallback)", () => {
      const subs = makeStubSubscriptions();
      const bus = new ModelChangeBus(null, subs as any);

      bus.notify("chat-message");

      expect(subs.onModelChange).toHaveBeenCalledWith("chat-message");
      expect(subs.onModelChange).toHaveBeenCalledTimes(1);
    });
  });

  describe("cross-process", () => {
    it("delivers an emit from bus A to bus B's subscriptions", () => {
      const pubsubA = makeStubPubSub();
      const pubsubB = makeStubPubSub();
      bridge(pubsubA, pubsubB);

      const subsA = makeStubSubscriptions();
      const subsB = makeStubSubscriptions();
      const busA = new ModelChangeBus(pubsubA as any, subsA as any);
      const busB = new ModelChangeBus(pubsubB as any, subsB as any);

      busA.notify("chat-message");

      // A fires once (local fast-path), B fires once (via bridged emit).
      expect(subsA.onModelChange).toHaveBeenCalledTimes(1);
      expect(subsB.onModelChange).toHaveBeenCalledWith("chat-message");
      expect(subsB.onModelChange).toHaveBeenCalledTimes(1);
    });

    it("two different originators are not confused for each other", () => {
      const pubsubA = makeStubPubSub();
      const pubsubB = makeStubPubSub();
      bridge(pubsubA, pubsubB);

      const subsA = makeStubSubscriptions();
      const subsB = makeStubSubscriptions();
      const busA = new ModelChangeBus(pubsubA as any, subsA as any);
      const busB = new ModelChangeBus(pubsubB as any, subsB as any);

      expect(busA.originatorId).not.toBe(busB.originatorId);

      busA.notify("chat-message");
      busB.notify("nudge");

      expect(subsA.calls).toEqual(["chat-message", "nudge"]);
      expect(subsB.calls).toEqual(["chat-message", "nudge"]);
    });
  });
});
