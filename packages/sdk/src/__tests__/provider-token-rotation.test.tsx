import { EventEmitter } from "eventemitter3";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthClientAdapter } from "../auth-adapter";
import type { ClientConfig, ParcaeClient } from "../client";
import { ConnectionMachine } from "../connection-machine";
import { ParcaeProvider } from "../react/Provider";
import { SessionMachine } from "../session-machine";

const queryMocks = vi.hoisted(() => ({
  purge: vi.fn(),
  resync: vi.fn(),
}));

vi.mock("../react/useQuery", () => ({
  _purgeCacheForUser: queryMocks.purge,
  _onResyncRequired: queryMocks.resync,
}));

const clientFactory = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("../client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../client")>();
  return {
    ...original,
    _getOrCreateProviderClient: clientFactory.create,
  };
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function jwt(payload: object): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

const USER_1 = { sub: "user-1", org_id: "org-1", org_role: "org:member" };

class FakeClient extends EventEmitter {
  session = new SessionMachine();
  connection = new ConnectionMachine();
  isConnected = true;
  needsSessionRefresh = false;
  disconnect = vi.fn();
  refreshCalls = 0;
  terminateCalls = 0;
  confirmedToken: string | null = null;
  deferNextRefresh = false;
  private releaseRefresh: (() => void) | null = null;
  private getToken: ClientConfig["getToken"] | null = null;
  private tokenResolverLease: object | null = null;

  _lastConfirmedToken(): string | null {
    return this.confirmedToken;
  }

  releaseDeferredRefresh(): void {
    this.releaseRefresh?.();
    this.releaseRefresh = null;
  }

  get hasTokenResolverLease(): boolean {
    return this.tokenResolverLease !== null;
  }

  acquireTokenResolverLease(
    lease: object,
    getToken: ClientConfig["getToken"],
  ): void {
    this.tokenResolverLease = lease;
    this.getToken = getToken;
  }

  releaseTokenResolverLease(lease: object): boolean {
    if (this.tokenResolverLease === lease) {
      this.tokenResolverLease = null;
      return true;
    }
    return false;
  }

  async refreshSession(): Promise<{ userId: string | null }> {
    this.refreshCalls += 1;
    this.session.beginReconciliation();
    if (this.deferNextRefresh) {
      this.deferNextRefresh = false;
      await new Promise<void>((resolve) => {
        this.releaseRefresh = resolve;
      });
    }
    const token = await this.getToken?.();
    let userId: string | null = null;
    if (typeof token === "string") {
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1]!, "base64").toString(),
      ) as { sub?: string };
      userId = payload.sub ?? null;
    }
    this.session.resolve(userId);
    this.confirmedToken = typeof token === "string" ? token : null;
    return { userId };
  }

  async terminateSession(): Promise<void> {
    this.terminateCalls += 1;
    this.confirmedToken = null;
    this.session.terminate();
  }
}

function asClient(client: FakeClient): ParcaeClient {
  return client as unknown as ParcaeClient;
}

describe("ParcaeProvider token rotation", () => {
  let renderer: ReactTestRenderer | null = null;
  let notify: ((token: string | null) => void) | null = null;

  function adapter(getToken: () => Promise<string | null>): AuthClientAdapter {
    return {
      init: vi.fn(),
      getToken,
      onChange: vi.fn((listener: (token: string | null) => void) => {
        notify = listener;
        return () => {
          notify = null;
        };
      }),
    };
  }

  const currentRenderer = (): ReactTestRenderer => {
    if (!renderer) throw new Error("renderer is not mounted");
    return renderer;
  };

  async function mountAuthenticated(client: FakeClient): Promise<void> {
    clientFactory.create.mockImplementation(() => asClient(client));
    const auth = adapter(async () =>
      jwt({ ...USER_1, iat: 1000, exp: 1060 }),
    );
    await act(async () => {
      renderer = create(
        <ParcaeProvider url="https://api.example" auth={auth}>
          <div>private route</div>
        </ParcaeProvider>,
      );
    });
    await act(async () => {
      client.confirmedToken = jwt({ ...USER_1, iat: 1000, exp: 1060 });
      client.session.resolve("user-1");
      await client.session.ready;
    });
    expect(currentRenderer().toJSON()).not.toBeNull();
  }

  afterEach(async () => {
    if (renderer) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
    notify = null;
    queryMocks.purge.mockClear();
    clientFactory.create.mockReset();
  });

  it("keeps children mounted through a pure token rotation", async () => {
    const client = new FakeClient();
    await mountAuthenticated(client);
    const refreshesAfterMount = client.refreshCalls;

    await act(async () => {
      notify?.(jwt({ ...USER_1, iat: 1030, exp: 1090 }));
    });

    expect(currentRenderer().toJSON()).not.toBeNull();
    expect(client.refreshCalls).toBe(refreshesAfterMount);
  });

  it("closes the tree when a rotation carries a different authorization", async () => {
    const client = new FakeClient();
    await mountAuthenticated(client);
    const refreshesAfterMount = client.refreshCalls;

    client.deferNextRefresh = true;
    await act(async () => {
      notify?.(
        jwt({ ...USER_1, org_role: "org:admin", iat: 1030, exp: 1090 }),
      );
    });

    expect(client.refreshCalls).toBe(refreshesAfterMount + 1);
    expect(currentRenderer().toJSON()).toBeNull();

    await act(async () => {
      client.releaseDeferredRefresh();
    });
    expect(currentRenderer().toJSON()).not.toBeNull();
  });

  it("still reconciles fully when the token is not a decodable JWT", async () => {
    const client = new FakeClient();
    await mountAuthenticated(client);
    const refreshesAfterMount = client.refreshCalls;

    await act(async () => {
      notify?.("opaque-token");
    });
    await act(async () => {
      notify?.("opaque-token");
    });

    expect(client.refreshCalls).toBe(refreshesAfterMount + 2);
  });

  it("terminates on sign-out and reconciles the next sign-in", async () => {
    const client = new FakeClient();
    await mountAuthenticated(client);

    await act(async () => {
      notify?.(null);
    });
    expect(client.terminateCalls).toBe(1);
    expect(currentRenderer().toJSON()).toBeNull();

    const refreshesAfterSignOut = client.refreshCalls;
    await act(async () => {
      notify?.(jwt({ ...USER_1, iat: 2000, exp: 2060 }));
    });
    expect(client.refreshCalls).toBe(refreshesAfterSignOut + 1);
  });
});
