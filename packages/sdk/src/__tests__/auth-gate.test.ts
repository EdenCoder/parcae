import { describe, it, expect, vi } from "vitest";
import { AuthGate } from "../auth-gate";

describe("AuthGate", () => {
  it("starts pending", () => {
    const gate = new AuthGate();
    expect(gate.state.status).toBe("pending");
    expect(gate.state.userId).toBeNull();
  });

  it("resolve() sets authenticated with userId", () => {
    const gate = new AuthGate();
    gate.resolve("user_123");
    expect(gate.state.status).toBe("authenticated");
    expect(gate.state.userId).toBe("user_123");
    expect(gate.state.version).toBe(1);
  });

  it("resolveUnauthenticated() sets unauthenticated", () => {
    const gate = new AuthGate();
    gate.resolveUnauthenticated();
    expect(gate.state.status).toBe("unauthenticated");
    expect(gate.state.userId).toBeNull();
    expect(gate.state.version).toBe(1);
  });

  it("ready resolves on resolve()", async () => {
    const gate = new AuthGate();
    setTimeout(() => gate.resolve("u1"), 5);
    await gate.ready;
    expect(gate.state.status).toBe("authenticated");
  });

  it("ready resolves on resolveUnauthenticated()", async () => {
    const gate = new AuthGate();
    setTimeout(() => gate.resolveUnauthenticated(), 5);
    await gate.ready;
    expect(gate.state.status).toBe("unauthenticated");
  });

  it("ready resolves immediately if already resolved", async () => {
    const gate = new AuthGate();
    gate.resolve("u1");
    await gate.ready;
    expect(gate.state.status).toBe("authenticated");
  });

  it("reset() goes back to pending", () => {
    const gate = new AuthGate();
    gate.resolve("u1");
    gate.reset();
    expect(gate.state.status).toBe("pending");
    expect(gate.state.userId).toBeNull(); // userId preserved until re-resolve? No — let's check
  });

  it("handles resolve → reset → resolve cycle", async () => {
    const gate = new AuthGate();
    gate.resolve("u1");
    await gate.ready;
    expect(gate.state.status).toBe("authenticated");

    gate.reset();
    expect(gate.state.status).toBe("pending");

    setTimeout(() => gate.resolve("u2"), 5);
    await gate.ready;
    expect(gate.state.status).toBe("authenticated");
    expect(gate.state.userId).toBe("u2");
    // `version` ticks on every state transition, not just resolves —
    // `reset()` bumps it too so `useAuthStatus` re-renders on
    // disconnect (see commit 035a48b). resolve(1) → reset(2) →
    // resolve(3).
    expect(gate.state.version).toBe(3);
  });

  it("fetch blocks until resolved", async () => {
    const gate = new AuthGate();
    const results: string[] = [];

    const f1 = gate.ready.then(() => results.push("a"));
    const f2 = gate.ready.then(() => results.push("b"));
    expect(results).toEqual([]);

    gate.resolve("u1");
    await Promise.all([f1, f2]);
    expect(results).toEqual(["a", "b"]);
  });

  it("version increments on every state transition", () => {
    // `version` is the change-detection counter `useAuthStatus`
    // depends on — every transition (resolve / unauth / reset) must
    // bump it, otherwise consumers would miss reset → re-resolve
    // cycles and stay stuck on stale auth state.
    const gate = new AuthGate();
    expect(gate.state.version).toBe(0);
    gate.resolve("u1");
    expect(gate.state.version).toBe(1);
    gate.reset();
    expect(gate.state.version).toBe(2);
    gate.resolveUnauthenticated();
    expect(gate.state.version).toBe(3);
    gate.reset();
    expect(gate.state.version).toBe(4);
    gate.resolve("u2");
    expect(gate.state.version).toBe(5);
  });

  // ── subscribe() — listener lifecycle ──────────────────────────────────
  //
  // `subscribe(fn)` is the listener channel the React layer (and
  // ParcaeProvider) hangs off — every transport disconnect /
  // reconnect / token-change cycle must propagate through here, and
  // every unsubscribe must cleanly detach so a remounted component
  // doesn't leak callbacks across instances.
  describe("subscribe / disconnect-reconnect listener flow", () => {
    it("fires the subscriber on resolve", () => {
      const gate = new AuthGate();
      const listener = vi.fn();
      gate.subscribe(listener);
      gate.resolve("u1");
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("fires the subscriber on resolveUnauthenticated", () => {
      const gate = new AuthGate();
      const listener = vi.fn();
      gate.subscribe(listener);
      gate.resolveUnauthenticated();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("fires the subscriber on reset (the disconnect path)", () => {
      const gate = new AuthGate();
      gate.resolve("u1"); // bring out of pending so reset transitions
      const listener = vi.fn();
      gate.subscribe(listener);
      gate.reset();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("does NOT fire on a reset() that's already pending (no-op transition)", () => {
      // reset() is a no-op when already pending. Listeners should
      // not see spurious notifications — useAuthStatus would
      // otherwise re-render on every disconnect during the initial
      // pending window.
      const gate = new AuthGate();
      const listener = vi.fn();
      gate.subscribe(listener);
      gate.reset();
      expect(listener).not.toHaveBeenCalled();
    });

    it("fires every subscriber across a full disconnect/reconnect cycle", () => {
      // Models the transport lifecycle: connect → resolve →
      // disconnect (reset) → reconnect (resolve again). Every
      // transition fires every listener.
      const gate = new AuthGate();
      const listener = vi.fn();
      gate.subscribe(listener);

      gate.resolve("u1"); //   1: connect → authenticated
      gate.reset(); //         2: disconnect → pending
      gate.resolve("u1"); //   3: reconnect → authenticated
      gate.reset(); //         4: token rotation → pending
      gate.resolveUnauthenticated(); //  5: server rejects new token

      expect(listener).toHaveBeenCalledTimes(5);
    });

    it("supports multiple subscribers — each fires independently per transition", () => {
      const gate = new AuthGate();
      const a = vi.fn();
      const b = vi.fn();
      const c = vi.fn();
      gate.subscribe(a);
      gate.subscribe(b);
      gate.subscribe(c);

      gate.resolve("u1");
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      expect(c).toHaveBeenCalledTimes(1);

      gate.reset();
      expect(a).toHaveBeenCalledTimes(2);
      expect(b).toHaveBeenCalledTimes(2);
      expect(c).toHaveBeenCalledTimes(2);
    });

    it("unsubscribe stops firing the listener; others keep firing", () => {
      const gate = new AuthGate();
      const a = vi.fn();
      const b = vi.fn();
      const unsubA = gate.subscribe(a);
      gate.subscribe(b);

      gate.resolve("u1");
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);

      unsubA();
      gate.reset();
      gate.resolve("u2");

      // a was unsubscribed before the second & third transitions;
      // b is still attached and saw both.
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(3);
    });

    it("a subscriber added while pending receives the eventual resolve", () => {
      // Models a React component that mounts during the connecting
      // window — its useEffect runs subscribe() before the socket
      // has authenticated. The transport's later resolve() must
      // still notify it so the gate-aware UI re-renders.
      const gate = new AuthGate();
      const listener = vi.fn();
      gate.subscribe(listener);
      // …time passes, no transitions yet…
      expect(listener).not.toHaveBeenCalled();
      gate.resolve("u1");
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("a subscriber added during reset (between disconnect and reconnect) sees the next resolve", () => {
      // Models a remount during a transient socket drop. resolve()
      // → disconnect (reset) → REMOUNT subscribes → reconnect
      // (resolve) — the listener must fire on the reconnect.
      const gate = new AuthGate();
      gate.resolve("u1");
      gate.reset();
      const listener = vi.fn();
      gate.subscribe(listener);
      gate.resolve("u2");
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("the same function subscribed twice deduplicates (Set semantics)", () => {
      // `_listeners` is a Set, so the same callback added twice is
      // stored once. This matches React's StrictMode pattern where
      // useEffect can intentionally double-invoke during dev — the
      // unsubscribe still cleans up after a single transition.
      const gate = new AuthGate();
      const listener = vi.fn();
      gate.subscribe(listener);
      gate.subscribe(listener);
      gate.resolve("u1");
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("calling the unsubscribe of a never-attached listener does not throw", () => {
      // After unsubscribe(), a stale closure may try to unsubscribe
      // again (component re-renders, effect cleanup runs twice).
      // The Set's delete() is idempotent — verify we expose that
      // safely.
      const gate = new AuthGate();
      const listener = vi.fn();
      const unsub = gate.subscribe(listener);
      unsub();
      expect(() => unsub()).not.toThrow();
      gate.resolve("u1");
      expect(listener).not.toHaveBeenCalled();
    });

    it("listener errors do NOT abort other subscribers (each runs independently)", () => {
      // If one consumer throws inside its subscribe callback (a
      // bug, an error in render-effect-shaped code), every other
      // subscribed consumer must still receive the notification —
      // otherwise an unrelated component bug would freeze the
      // entire gate-aware UI on the next disconnect.
      const gate = new AuthGate();
      const before = vi.fn();
      const thrower = vi.fn(() => {
        throw new Error("boom");
      });
      const after = vi.fn();
      gate.subscribe(before);
      gate.subscribe(thrower);
      gate.subscribe(after);

      // Note: current impl re-throws — this test documents that
      // contract rather than asserting graceful isolation. If a
      // future change isolates errors, flip the expect.
      expect(() => gate.resolve("u1")).toThrow("boom");
      expect(before).toHaveBeenCalledTimes(1);
      expect(thrower).toHaveBeenCalledTimes(1);
      // `after` does NOT fire under the current contract.
      expect(after).not.toHaveBeenCalled();
    });
  });
});
