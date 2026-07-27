import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _clientCacheKeyForTest,
  _getOrCreateProviderClient,
  _rememberConnectionConfigForTest,
  createClient,
  type ParcaeClient,
} from "../client";

const clients = () =>
  (
    globalThis as typeof globalThis & {
      __parcae_clients?: Map<string, ParcaeClient>;
    }
  ).__parcae_clients;

describe("createClient cache", () => {
  const cacheKey = (url: string, version = "v1") =>
    _clientCacheKeyForTest(url, version);
  const defaultConfig = {
    url: "https://api.example",
    getToken: async () => null,
  };

  afterEach(() => {
    clients()?.clear();
  });

  it("updates the token resolver before returning a cached client", () => {
    const updateTokenResolver = vi.fn();
    const existing = {
      updateTokenResolver,
    } as unknown as ParcaeClient;
    _rememberConnectionConfigForTest(existing, defaultConfig);
    (
      globalThis as typeof globalThis & {
        __parcae_clients: Map<string, ParcaeClient>;
      }
    ).__parcae_clients = new Map([[cacheKey("https://api.example"), existing]]);
    const nextResolver = async () => "next-token";

    const result = createClient({
      url: "https://api.example",
      getToken: nextResolver,
    });

    expect(result).toBe(existing);
    expect(updateTokenResolver).toHaveBeenCalledOnce();
    expect(updateTokenResolver).toHaveBeenCalledWith(nextResolver);
  });

  it("fails closed without this module's immutable cache metadata", () => {
    const existing = {} as ParcaeClient;
    (
      globalThis as typeof globalThis & {
        __parcae_clients: Map<string, ParcaeClient>;
      }
    ).__parcae_clients = new Map([[cacheKey("https://api.example"), existing]]);

    expect(() =>
      createClient({
        url: "https://api.example",
        getToken: async () => "next-token",
      }),
    ).toThrow("reload required");
  });

  it("fails closed when a legacy concatenated cache key retains an old socket", () => {
    const legacy = {} as ParcaeClient;
    (
      globalThis as typeof globalThis & {
        __parcae_clients: Map<string, ParcaeClient>;
      }
    ).__parcae_clients = new Map([["https://api.example:v1", legacy]]);

    expect(() =>
      createClient({
        url: "https://api.example",
        getToken: async () => "next-token",
      }),
    ).toThrow("Legacy cached Parcae client");
    expect(clients()?.size).toBe(1);
    expect(clients()?.get("https://api.example:v1")).toBe(legacy);
  });

  it("does not let a direct caller replace an active Provider's resolver", () => {
    const updateTokenResolver = vi.fn();
    const existing = {
      hasTokenResolverLease: true,
      updateTokenResolver,
    } as unknown as ParcaeClient;
    _rememberConnectionConfigForTest(existing, defaultConfig);
    (
      globalThis as typeof globalThis & {
        __parcae_clients: Map<string, ParcaeClient>;
      }
    ).__parcae_clients = new Map([[cacheKey("https://api.example"), existing]]);

    expect(() =>
      createClient({
        url: "https://api.example",
        getToken: async () => "different-owner-token",
      }),
    ).toThrow("active Provider");
    expect(updateTokenResolver).not.toHaveBeenCalled();
  });

  it("does not mutate a cached resolver during Provider render", () => {
    const updateTokenResolver = vi.fn();
    const existing = {
      updateTokenResolver,
    } as unknown as ParcaeClient;
    _rememberConnectionConfigForTest(existing, defaultConfig);
    (
      globalThis as typeof globalThis & {
        __parcae_clients: Map<string, ParcaeClient>;
      }
    ).__parcae_clients = new Map([[cacheKey("https://api.example"), existing]]);

    const result = _getOrCreateProviderClient({
      url: "https://api.example",
      getToken: async () => "speculative-token",
    });

    expect(result).toBe(existing);
    expect(updateTokenResolver).not.toHaveBeenCalled();
  });

  it("fails closed when cached immutable connection headers change", () => {
    const updateTokenResolver = vi.fn();
    const existing = {
      updateTokenResolver,
    } as unknown as ParcaeClient;
    _rememberConnectionConfigForTest(existing, {
      url: "https://api.example",
      getToken: async () => null,
      extraHeaders: { "x-tenant": "tenant-a" },
    });
    (
      globalThis as typeof globalThis & {
        __parcae_clients: Map<string, ParcaeClient>;
      }
    ).__parcae_clients = new Map([[cacheKey("https://api.example"), existing]]);

    expect(() =>
      createClient({
        url: "https://api.example",
        getToken: async () => "tenant-b-token",
        extraHeaders: { "x-tenant": "tenant-b" },
      }),
    ).toThrow("incompatible transports or extraHeaders");
    expect(updateTokenResolver).not.toHaveBeenCalled();
  });

  it("accepts reordered equivalent headers without exposing a secret record", () => {
    const updateTokenResolver = vi.fn();
    const existing = { updateTokenResolver } as unknown as ParcaeClient;
    _rememberConnectionConfigForTest(existing, {
      url: "https://api.example",
      getToken: async () => null,
      extraHeaders: {
        authorization: "sentinel-super-secret",
        "x-device": "device-a",
      },
    });
    (
      globalThis as typeof globalThis & {
        __parcae_clients: Map<string, ParcaeClient>;
      }
    ).__parcae_clients = new Map([[cacheKey("https://api.example"), existing]]);

    const result = createClient({
      url: "https://api.example",
      getToken: async () => null,
      extraHeaders: {
        "x-device": "device-a",
        authorization: "sentinel-super-secret",
      },
    });

    expect(result).toBe(existing);
    expect(JSON.stringify(existing)).not.toContain("sentinel-super-secret");
  });

  it("does not collide when URL and version contain separators", () => {
    expect(cacheKey("https://api.example:tenant", "v1")).not.toBe(
      cacheKey("https://api.example", "tenant:v1"),
    );
  });
});
