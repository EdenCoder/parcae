import { describe, expect, it, vi } from "vitest";
import { createClerkAuthAdapter } from "../client.js";

describe("createClerkAuthAdapter", () => {
  it("propagates token read errors", async () => {
    const failure = new Error("Clerk unavailable");
    const adapter = createClerkAuthAdapter(async () => {
      throw failure;
    }, { subscribe: () => () => {} });

    await expect(adapter.getToken()).rejects.toBe(failure);
  });

  it("reads tokens from the supplied Clerk session change source", async () => {
    let onSessionChange: (() => void) | null = null;
    const getToken = vi.fn().mockResolvedValue("token-2");
    const adapter = createClerkAuthAdapter(getToken, {
      subscribe(callback) {
        onSessionChange = callback;
        return () => {
          onSessionChange = null;
        };
      },
    });
    const onChange = vi.fn();
    const unsubscribe = adapter.onChange!(onChange);

    onSessionChange!();
    await Promise.resolve();
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledWith("token-2");

    unsubscribe();
    expect(onSessionChange).toBeNull();
  });
});
