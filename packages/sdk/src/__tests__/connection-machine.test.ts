import { describe, expect, it, vi } from "vitest";
import { ConnectionMachine } from "../connection-machine";

describe("ConnectionMachine", () => {
  it("starts in idle", () => {
    const c = new ConnectionMachine();
    expect(c.state.status).toBe("idle");
    expect(c.state.version).toBe(0);
    expect(c.state.lastConnectedAt).toBeNull();
  });

  it("connecting → connected → disconnected cycles bump version and notify", () => {
    const c = new ConnectionMachine();
    const fn = vi.fn();
    c.subscribe(fn);

    c.connecting();
    c.connected();
    c.disconnected();
    expect(c.state.status).toBe("disconnected");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(c.state.version).toBe(3);
  });

  it("connected() records lastConnectedAt", () => {
    const c = new ConnectionMachine();
    expect(c.state.lastConnectedAt).toBeNull();
    c.connected();
    expect(typeof c.state.lastConnectedAt).toBe("number");
  });

  it("setting the same status twice is a no-op", () => {
    const c = new ConnectionMachine();
    const fn = vi.fn();
    c.subscribe(fn);
    c.connecting();
    c.connecting();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("disconnected(err) records the error", () => {
    const c = new ConnectionMachine();
    c.connected();
    const err = new Error("transport closed");
    c.disconnected(err);
    expect(c.state.lastError).toBe(err);
  });
});
