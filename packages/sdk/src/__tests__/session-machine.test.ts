import { describe, expect, it, vi } from "vitest";
import { SessionMachine } from "../session-machine";

describe("SessionMachine", () => {
  it("starts in pending with version 0", () => {
    const s = new SessionMachine();
    expect(s.state.status).toBe("pending");
    expect(s.state.userId).toBeNull();
    expect(s.state.version).toBe(0);
  });

  it("resolve(userId) transitions to authenticated and bumps version", () => {
    const s = new SessionMachine();
    s.resolve("u1");
    expect(s.state.status).toBe("authenticated");
    expect(s.state.userId).toBe("u1");
    expect(s.state.version).toBe(1);
  });

  it("resolve(null) transitions to anonymous and bumps version", () => {
    const s = new SessionMachine();
    s.resolve(null);
    expect(s.state.status).toBe("anonymous");
    expect(s.state.userId).toBeNull();
    expect(s.state.version).toBe(1);
  });

  it("a second resolve confirming the same user is a no-op (no notify, no version bump)", () => {
    const s = new SessionMachine();
    s.resolve("u1");
    const v = s.state.version;
    const fn = vi.fn();
    s.subscribe(fn);
    s.resolve("u1");
    expect(s.state.version).toBe(v);
    expect(fn).not.toHaveBeenCalled();
  });

  it("resolve(u2) after resolve(u1) is a user switch — notify fires", () => {
    const s = new SessionMachine();
    s.resolve("u1");
    const fn = vi.fn();
    s.subscribe(fn);
    s.resolve("u2");
    expect(s.state.userId).toBe("u2");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("ready resolves on the first resolve regardless of authenticated/anonymous", async () => {
    const s = new SessionMachine();
    let settled = false;
    s.ready.then(() => {
      settled = true;
    });
    s.resolve(null);
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it("reconciliation closes the session while retaining the prior owner for purge", async () => {
    const s = new SessionMachine();
    s.resolve("u1");
    const notify = vi.fn();
    s.subscribe(notify);

    s.beginReconciliation();

    expect(s.state).toMatchObject({ status: "pending", userId: "u1" });
    let ready = false;
    void s.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(notify).toHaveBeenCalledOnce();

    s.resolve("u2");
    await s.ready;
    expect(s.state).toMatchObject({ status: "authenticated", userId: "u2" });
  });

  it("terminate() locks the machine — subsequent resolve() is ignored", () => {
    const s = new SessionMachine();
    s.resolve("u1");
    s.terminate();
    s.resolve("u2");
    expect(s.state.status).toBe("terminated");
    expect(s.state.userId).toBeNull();
  });

  it("subscribers see exactly one notify per state change", () => {
    const s = new SessionMachine();
    const fn = vi.fn();
    s.subscribe(fn);
    s.resolve("u1"); // 1
    s.resolve("u1"); // no-op
    s.resolve("u2"); // 2
    s.terminate(); // 3
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("isolates a throwing listener so later boundary listeners always run", () => {
    const s = new SessionMachine();
    s.resolve("u1");
    const throwing = vi.fn(() => {
      throw new Error("prior-owner-phi");
    });
    const purgeAndClose = vi.fn();
    s.subscribe(throwing);
    s.subscribe(purgeAndClose);

    expect(() => s.beginReconciliation()).not.toThrow();
    expect(throwing).toHaveBeenCalledOnce();
    expect(purgeAndClose).toHaveBeenCalledOnce();
    expect(s.state).toMatchObject({ status: "pending", userId: "u1" });

    expect(() => s.resolve("u2")).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(2);
    expect(purgeAndClose).toHaveBeenCalledTimes(2);
    expect(s.state).toMatchObject({ status: "authenticated", userId: "u2" });
  });
});
