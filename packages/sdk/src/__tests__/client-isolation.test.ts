import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  disconnect: vi.fn(),
  modelUse: vi.fn(),
  clearRefCache: vi.fn(),
}));

vi.mock("@parcae/model", () => ({
  FrontendAdapter: class FrontendAdapter {
    constructor(public transport: unknown) {}
  },
  Model: { use: mocks.modelUse, clearRefCache: mocks.clearRefCache },
}));

vi.mock("../transports/socket", () => ({
  SocketTransport: class SocketTransport {
    session = {
      state: { status: "anonymous", userId: null },
      subscribe: vi.fn(() => () => undefined),
    };
    connection = { state: { status: "connected" } };
    isConnected = true;
    needsSessionRefresh = false;
    hasTokenResolverLease = false;

    constructor(config: Record<string, unknown>) {
      mocks.configs.push(config);
    }

    get = vi.fn();
    post = vi.fn();
    put = vi.fn();
    patch = vi.fn();
    delete = vi.fn();
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    send = vi.fn();
    updateTokenResolver = vi.fn();
    acquireTokenResolverLease = vi.fn();
    releaseTokenResolverLease = vi.fn();
    refreshSession = vi.fn();
    terminateSession = vi.fn();
    resync = vi.fn();
    on = vi.fn();
    off = vi.fn();
    disconnect = mocks.disconnect;
    reconnect = vi.fn();
  },
}));

import { createClient, withIsolatedClient, type ParcaeClient } from "../client";

const clients = () =>
  (
    globalThis as typeof globalThis & {
      __parcae_clients?: Map<string, ParcaeClient>;
    }
  ).__parcae_clients;

describe("isolated clients", () => {
  afterEach(() => {
    clients()?.clear();
    mocks.configs.length = 0;
    vi.clearAllMocks();
  });

  it("uses an unpooled socket, leaves the global model adapter intact, and disconnects", async () => {
    const result = await withIsolatedClient(
      {
        url: "https://api.example",
        getToken: async () => "one-shot-token",
      },
      async () => "done",
    );

    expect(result).toBe("done");
    expect(mocks.configs).toHaveLength(1);
    expect(mocks.modelUse).not.toHaveBeenCalled();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it("disconnects when the isolated operation rejects", async () => {
    const failure = new Error("operation failed");

    await expect(
      withIsolatedClient(
        {
          url: "https://api.example",
          getToken: async () => "one-shot-token",
        },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps the primary client cached and installs its model adapter", () => {
    createClient({
      url: "https://api.example",
      getToken: async () => "primary-token",
    });

    expect(mocks.modelUse).toHaveBeenCalledOnce();
  });

  it("fails closed before a second primary client can replace the Model adapter", () => {
    createClient({
      url: "https://api-one.example",
      getToken: async () => "primary-token",
    });

    expect(() =>
      createClient({
        url: "https://api-two.example",
        getToken: async () => "other-token",
      }),
    ).toThrow("one primary Model client per realm");
    expect(mocks.configs).toHaveLength(1);
    expect(mocks.modelUse).toHaveBeenCalledOnce();
  });
});
