import { describe, expect, it, vi } from "vitest";

import { __test as providerTest } from "../react/Provider";

describe("ParcaeProvider reconnect auth policy", () => {
  it("does not downgrade an already-authenticated socket when reconnect token refresh returns null", async () => {
    const auth = {
      getToken: vi.fn(async () => null),
    };
    const client = {
      authenticate: vi.fn(async (token: string | null) => ({
        userId: token ? "u1" : null,
      })),
    };

    await providerTest.handleReconnectAuth(auth as any, client as any);

    expect(auth.getToken).toHaveBeenCalledTimes(1);
    expect(client.authenticate).not.toHaveBeenCalled();
  });

  it("re-authenticates with a refreshed token when reconnect token refresh succeeds", async () => {
    const auth = {
      getToken: vi.fn(async () => "tok-refreshed"),
    };
    const client = {
      authenticate: vi.fn(async (token: string | null) => ({
        userId: token ? "u1" : null,
      })),
    };

    await providerTest.handleReconnectAuth(auth as any, client as any);

    expect(client.authenticate).toHaveBeenCalledTimes(1);
    expect(client.authenticate).toHaveBeenCalledWith("tok-refreshed");
  });

  it("does not downgrade auth when reconnect token refresh throws", async () => {
    const auth = {
      getToken: vi.fn(async () => {
        throw new Error("session unavailable");
      }),
    };
    const client = {
      authenticate: vi.fn(async (token: string | null) => ({
        userId: token ? "u1" : null,
      })),
    };

    await providerTest.handleReconnectAuth(auth as any, client as any);

    expect(client.authenticate).not.toHaveBeenCalled();
  });
});
