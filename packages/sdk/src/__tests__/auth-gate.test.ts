import { describe, it, expect } from "vitest";
import { AuthGate } from "../auth-gate";

describe("AuthGate", () => {
  it("should start in pending state", () => {
    const gate = new AuthGate();
    expect(gate.state).toBe("pending");
  });

  it("resolve() should set state to ready", () => {
    const gate = new AuthGate();
    gate.resolve();
    expect(gate.state).toBe("ready");
  });

  it("ready should be an awaitable promise", async () => {
    const gate = new AuthGate();
    // Resolve after a tick
    setTimeout(() => gate.resolve(), 5);
    await gate.ready;
    expect(gate.state).toBe("ready");
  });

  it("ready should resolve immediately if already resolved", async () => {
    const gate = new AuthGate();
    gate.resolve();
    // Should not hang
    await gate.ready;
    expect(gate.state).toBe("ready");
  });

  it("reset() should go back to pending", () => {
    const gate = new AuthGate();
    gate.resolve();
    expect(gate.state).toBe("ready");
    gate.reset();
    expect(gate.state).toBe("pending");
  });

  it("reset() on pending should be a no-op", () => {
    const gate = new AuthGate();
    gate.reset();
    expect(gate.state).toBe("pending");
  });

  it("should handle resolve → reset → resolve cycle", async () => {
    const gate = new AuthGate();

    // First cycle
    gate.resolve();
    await gate.ready;
    expect(gate.state).toBe("ready");

    // Reset (simulates disconnect)
    gate.reset();
    expect(gate.state).toBe("pending");

    // Second cycle (simulates reconnect + re-auth)
    setTimeout(() => gate.resolve(), 5);
    await gate.ready;
    expect(gate.state).toBe("ready");
  });

  it("multiple resolves should be idempotent", () => {
    const gate = new AuthGate();
    gate.resolve();
    gate.resolve();
    gate.resolve();
    expect(gate.state).toBe("ready");
  });

  it("fetch-like code should block until resolved", async () => {
    const gate = new AuthGate();
    const results: string[] = [];

    // Simulate two fetches that await auth
    const fetch1 = gate.ready.then(() => results.push("fetch1"));
    const fetch2 = gate.ready.then(() => results.push("fetch2"));

    // Nothing should have resolved yet
    expect(results).toEqual([]);

    // Resolve auth
    gate.resolve();

    await Promise.all([fetch1, fetch2]);
    expect(results).toEqual(["fetch1", "fetch2"]);
  });

  it("reset during pending waiters should make them wait for new resolve", async () => {
    const gate = new AuthGate();
    const results: string[] = [];

    // Start waiting
    const waiter1 = gate.ready.then(() => results.push("first"));

    // Resolve first cycle
    gate.resolve();
    await waiter1;
    expect(results).toEqual(["first"]);

    // Reset
    gate.reset();

    // New waiter should block
    const waiter2 = gate.ready.then(() => results.push("second"));

    // Should not have resolved yet
    await new Promise((r) => setTimeout(r, 10));
    expect(results).toEqual(["first"]);

    // Resolve second cycle
    gate.resolve();
    await waiter2;
    expect(results).toEqual(["first", "second"]);
  });
});
