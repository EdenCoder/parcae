/**
 * withIsolatedClient — one-shot work on a private socket.
 *
 * Every client is already physically isolated on master (createClient
 * never caches or shares transports); the wrapper's contract is that
 * the socket is always released and the global Model binding is never
 * touched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Model } from "@parcae/model";

class FakeSocket {
  connected = false;
  disconnectCalls = 0;
  private handlers = new Map<string, Set<(...args: any[]) => void>>();
  on(event: string, handler: (...args: any[]) => void): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return this;
  }
  once(event: string, handler: (...args: any[]) => void): this {
    return this.on(event, handler);
  }
  off(): this {
    return this;
  }
  emit(): boolean {
    return true;
  }
  removeAllListeners(): void {
    this.handlers.clear();
  }
  disconnect(): void {
    this.disconnectCalls++;
    this.connected = false;
  }
  connect(): void {
    this.connected = true;
  }
}

let currentSocket: FakeSocket;

vi.mock("socket.io-client", () => ({
  default: vi.fn(() => {
    currentSocket = new FakeSocket();
    return currentSocket;
  }),
}));

// eslint-disable-next-line import/first
import { withIsolatedClient } from "../client";

const config = { url: "http://localhost:0", getToken: async () => null };

describe("withIsolatedClient", () => {
  afterEach(() => {
    (Model as any)._adapter = undefined;
  });

  it("never binds the global Model adapter", async () => {
    const hadAdapter = Model.hasAdapter();
    await withIsolatedClient(config, async (client) => {
      expect(client.adapter).toBeDefined();
      return null;
    });
    expect(Model.hasAdapter()).toBe(hadAdapter);
  });

  it("disposes the socket when the operation resolves", async () => {
    const result = await withIsolatedClient(config, async () => "done");
    expect(result).toBe("done");
    expect(currentSocket.disconnectCalls).toBeGreaterThan(0);
  });

  it("disposes the socket when the operation rejects", async () => {
    await expect(
      withIsolatedClient(config, async () => {
        throw new Error("push action failed");
      }),
    ).rejects.toThrow("push action failed");
    expect(currentSocket.disconnectCalls).toBeGreaterThan(0);
  });
});
