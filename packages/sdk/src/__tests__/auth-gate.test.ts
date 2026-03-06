import { describe, it, expect } from "vitest";
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
    expect(gate.state.version).toBe(2);
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

  it("version increments on each resolve", () => {
    const gate = new AuthGate();
    expect(gate.state.version).toBe(0);
    gate.resolve("u1");
    expect(gate.state.version).toBe(1);
    gate.reset();
    gate.resolveUnauthenticated();
    expect(gate.state.version).toBe(2);
    gate.reset();
    gate.resolve("u2");
    expect(gate.state.version).toBe(3);
  });
});
