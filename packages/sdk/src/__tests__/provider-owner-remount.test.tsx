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

class FakeClient extends EventEmitter {
  session = new SessionMachine();
  connection = new ConnectionMachine();
  isConnected = true;
  needsSessionRefresh = false;
  disconnect = vi.fn();
  private getToken: ClientConfig["getToken"] | null = null;
  private tokenResolverLease: object | null = null;

  updateTokenResolver(getToken: ClientConfig["getToken"]): void {
    if (this.tokenResolverLease) {
      throw new Error("resolver owned by Provider");
    }
    this.replaceTokenResolver(getToken);
  }

  get hasTokenResolverLease(): boolean {
    return this.tokenResolverLease !== null;
  }

  acquireTokenResolverLease(
    lease: object,
    getToken: ClientConfig["getToken"],
  ): void {
    if (this.tokenResolverLease && this.tokenResolverLease !== lease) {
      throw new Error("resolver owned by another Provider");
    }
    this.tokenResolverLease = lease;
    this.replaceTokenResolver(getToken);
  }

  releaseTokenResolverLease(lease: object): boolean {
    if (this.tokenResolverLease === lease) {
      this.tokenResolverLease = null;
      return true;
    }
    return false;
  }

  private replaceTokenResolver(getToken: ClientConfig["getToken"]): void {
    if (this.getToken && this.getToken !== getToken) {
      this.needsSessionRefresh = true;
      this.session.beginReconciliation();
    }
    this.getToken = getToken;
  }

  async refreshSession(): Promise<{ userId: string | null }> {
    this.session.beginReconciliation();
    const token = await this.getToken?.();
    this.needsSessionRefresh = false;
    const userId =
      token === "token-user-1"
        ? "user-1"
        : token === "token-user-2"
          ? "user-2"
          : null;
    this.session.resolve(userId);
    return { userId };
  }

  async terminateSession(): Promise<void> {
    this.session.terminate();
  }
}

function asClient(client: FakeClient): ParcaeClient {
  return client as unknown as ParcaeClient;
}

function authAdapter(
  getToken: () => Promise<string | null>,
): AuthClientAdapter {
  return {
    init: vi.fn(),
    getToken,
    onChange: vi.fn(() => () => undefined),
  };
}

describe("ParcaeProvider owner remount", () => {
  let renderer: ReactTestRenderer | null = null;

  const currentRenderer = (): ReactTestRenderer => {
    if (!renderer) throw new Error("renderer is not mounted");
    return renderer;
  };

  afterEach(async () => {
    if (renderer) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
    queryMocks.purge.mockClear();
    clientFactory.create.mockReset();
  });

  it("keeps children hidden until a cached client confirms the new owner", async () => {
    const client = new FakeClient();
    clientFactory.create.mockImplementation(() => asClient(client));
    const firstAuth = authAdapter(async () => "token-user-1");

    await act(async () => {
      renderer = create(
        <ParcaeProvider url="https://api.example" auth={firstAuth}>
          <div>private route</div>
        </ParcaeProvider>,
      );
    });
    expect(currentRenderer().toJSON()).toBeNull();

    await act(async () => {
      client.session.resolve("user-1");
      await client.session.ready;
    });
    expect(currentRenderer().toJSON()).not.toBeNull();

    await act(async () => renderer?.unmount());
    renderer = null;

    // The Provider may read the resolver more than once per mount (the
    // hello handshake and the rotation-fingerprint seed); release every
    // pending read together.
    const pendingTokenReads: ((token: string) => void)[] = [];
    const resolveSecondToken = (token: string) => {
      for (const resolve of pendingTokenReads.splice(0)) resolve(token);
    };
    const secondAuth = authAdapter(
      () =>
        new Promise<string>((resolve) => {
          pendingTokenReads.push(resolve);
        }),
    );

    await act(async () => {
      renderer = create(
        <ParcaeProvider url="https://api.example" auth={secondAuth}>
          <div>private route</div>
        </ParcaeProvider>,
      );
    });
    expect(currentRenderer().toJSON()).toBeNull();

    await act(async () => {
      resolveSecondToken("token-user-2");
    });

    expect(queryMocks.purge).toHaveBeenCalledWith(client, "user-1");
    expect(client.session.state.userId).toBe("user-2");
    expect(currentRenderer().toJSON()).not.toBeNull();
  });

  it("purges and terminates the owned session when the Provider unmounts", async () => {
    const client = new FakeClient();
    client.session.resolve("user-1");
    clientFactory.create.mockImplementation(() => asClient(client));

    await act(async () => {
      renderer = create(
        <ParcaeProvider
          url="https://api.example"
          auth={authAdapter(async () => "token-user-1")}
        >
          <div>private route</div>
        </ParcaeProvider>,
      );
    });
    expect(currentRenderer().toJSON()).not.toBeNull();

    queryMocks.purge.mockClear();
    await act(async () => renderer?.unmount());
    renderer = null;

    expect(queryMocks.purge).toHaveBeenCalledWith(client, "user-1");
    expect(client.session.state.status).toBe("terminated");
    expect(client.hasTokenResolverLease).toBe(false);
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it("stays closed after sign-out and reopens only after a confirmed sign-in", async () => {
    const client = new FakeClient();
    client.session.resolve("user-1");
    clientFactory.create.mockImplementation(() => asClient(client));
    let currentToken: string | null = "token-user-1";
    let notifyAuthChange: (token: string | null) => void = () => undefined;
    const auth: AuthClientAdapter = {
      init: vi.fn(),
      getToken: vi.fn(async () => currentToken),
      onChange: vi.fn((listener) => {
        notifyAuthChange = listener;
        return () => undefined;
      }),
    };

    await act(async () => {
      renderer = create(
        <ParcaeProvider url="https://api.example" auth={auth}>
          <div>private route</div>
        </ParcaeProvider>,
      );
    });
    expect(currentRenderer().toJSON()).not.toBeNull();

    queryMocks.purge.mockClear();
    await act(async () => {
      currentToken = null;
      notifyAuthChange(null);
    });

    expect(queryMocks.purge).toHaveBeenCalledWith(client, "user-1");
    expect(client.session.state.status).toBe("terminated");
    expect(currentRenderer().toJSON()).toBeNull();

    await act(async () => {
      currentToken = "token-user-2";
      notifyAuthChange(currentToken);
    });

    expect(client.session.state.userId).toBe("user-2");
    expect(currentRenderer().toJSON()).not.toBeNull();
  });

  it("stays closed and reports an auth reconciliation failure", async () => {
    const client = new FakeClient();
    client.session.resolve("user-1");
    clientFactory.create.mockImplementation(() => asClient(client));
    // Seed the fake with the resolver owned by the previous mount.
    client.updateTokenResolver(async () => "token-user-1");

    const failure = new Error("token unavailable");
    const onError = vi.fn();
    const nextAuth = authAdapter(async () => {
      throw failure;
    });

    await act(async () => {
      renderer = create(
        <ParcaeProvider
          url="https://api.example"
          auth={nextAuth}
          onError={onError}
        >
          <div>private route</div>
        </ParcaeProvider>,
      );
    });

    expect(currentRenderer().toJSON()).toBeNull();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(queryMocks.purge).toHaveBeenCalledWith(client, "user-1");
  });

  it("reconciles an external client's resolver before opening for a new owner", async () => {
    const client = new FakeClient();
    client.updateTokenResolver(async () => "token-user-1");
    await client.refreshSession();

    // The Provider may read the resolver more than once per mount (the
    // hello handshake and the rotation-fingerprint seed); release every
    // pending read together.
    const pendingTokenReads: ((token: string) => void)[] = [];
    const resolveSecondToken = (token: string) => {
      for (const resolve of pendingTokenReads.splice(0)) resolve(token);
    };
    const secondAuth = authAdapter(
      () =>
        new Promise<string>((resolve) => {
          pendingTokenReads.push(resolve);
        }),
    );

    await act(async () => {
      renderer = create(
        <ParcaeProvider client={asClient(client)} auth={secondAuth}>
          <div>private route</div>
        </ParcaeProvider>,
      );
    });
    expect(currentRenderer().toJSON()).toBeNull();

    await act(async () => {
      resolveSecondToken("token-user-2");
    });

    expect(queryMocks.purge).toHaveBeenCalledWith(client, "user-1");
    expect(client.session.state.userId).toBe("user-2");
    expect(currentRenderer().toJSON()).not.toBeNull();
  });

  it("fails closed when an external client cannot reconcile the auth source", async () => {
    const legacyClient = asClient(new FakeClient());
    legacyClient.acquireTokenResolverLease = undefined;
    legacyClient.releaseTokenResolverLease = undefined;

    await expect(
      act(async () => {
        renderer = create(
          <ParcaeProvider
            client={legacyClient}
            auth={authAdapter(async () => "token-user-2")}
          >
            <div>private route</div>
          </ParcaeProvider>,
        );
      }),
    ).rejects.toThrow("supports auth reconciliation");
  });

  it("fails closed if auth is removed from the same external client", async () => {
    const client = new FakeClient();
    const firstAuth = authAdapter(async () => "token-user-1");

    await act(async () => {
      renderer = create(
        <ParcaeProvider client={asClient(client)} auth={firstAuth}>
          <div>private route</div>
        </ParcaeProvider>,
      );
    });
    expect(client.session.state.userId).toBe("user-1");

    await expect(
      act(async () => {
        currentRenderer().update(
          <ParcaeProvider client={asClient(client)}>
            <div>must stay closed</div>
          </ParcaeProvider>,
        );
      }),
    ).rejects.toThrow("cannot remove `auth`");

    await client.refreshSession();
    expect(client.session.state.userId).toBe("user-1");
  });

  it("does not bind an external resolver during an abandoned render", async () => {
    const client = new FakeClient();
    const firstAuth = authAdapter(async () => "token-user-1");

    await act(async () => {
      renderer = create(
        <ParcaeProvider client={asClient(client)} auth={firstAuth}>
          <div>private route</div>
        </ParcaeProvider>,
      );
    });
    expect(client.session.state.userId).toBe("user-1");

    const AbortedSibling = () => {
      throw new Error("abort speculative render");
    };
    const secondAuth = authAdapter(async () => "token-user-2");

    await expect(
      act(async () => {
        create(
          <>
            <ParcaeProvider client={asClient(client)} auth={secondAuth}>
              <div>speculative private route</div>
            </ParcaeProvider>
            <AbortedSibling />
          </>,
        );
      }),
    ).rejects.toThrow("abort speculative render");

    await client.refreshSession();
    expect(client.session.state.userId).toBe("user-1");
    expect(currentRenderer().toJSON()).not.toBeNull();
  });

  it("does not create, cache, connect, or read auth for an abandoned internal Provider", async () => {
    const getToken = vi.fn(async () => "token-user-2");
    const speculativeAuth = authAdapter(getToken);
    const AbortedSibling = () => {
      throw new Error("abort speculative internal render");
    };

    await expect(
      act(async () => {
        create(
          <>
            <ParcaeProvider
              url="https://speculative.example"
              auth={speculativeAuth}
            >
              <div>speculative private route</div>
            </ParcaeProvider>
            <AbortedSibling />
          </>,
        );
      }),
    ).rejects.toThrow("abort speculative internal render");

    expect(clientFactory.create).not.toHaveBeenCalled();
    expect(speculativeAuth.init).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it("closes and restores Provider ownership after an out-of-band identity change", async () => {
    const client = new FakeClient();
    let resolveReconciliation: (token: string) => void = () => undefined;
    let tokenReads = 0;
    const firstAuth = authAdapter(async () => {
      tokenReads++;
      if (tokenReads === 1) {
        return "token-user-1";
      }
      return await new Promise<string>((resolve) => {
        resolveReconciliation = resolve;
      });
    });

    await act(async () => {
      renderer = create(
        <ParcaeProvider client={asClient(client)} auth={firstAuth}>
          <div>private route</div>
        </ParcaeProvider>,
      );
    });
    expect(client.session.state.userId).toBe("user-1");
    expect(currentRenderer().toJSON()).not.toBeNull();

    act(() => {
      client.session.resolve("user-2");
    });
    expect(currentRenderer().toJSON()).toBeNull();

    await act(async () => {
      resolveReconciliation("token-user-1");
    });
    expect(client.session.state.userId).toBe("user-1");
    expect(currentRenderer().toJSON()).not.toBeNull();
  });

  it("closes and purges during a direct same-user authorization refresh", async () => {
    const client = new FakeClient();
    const throwingListener = vi.fn(() => {
      throw new Error("prior-owner-phi");
    });
    client.session.subscribe(throwingListener);
    let deferToken = false;
    let resolveToken: (token: string) => void = () => undefined;
    const auth = authAdapter(() => {
      if (!deferToken) return Promise.resolve("token-user-1");
      return new Promise<string>((resolve) => {
        resolveToken = resolve;
      });
    });

    await act(async () => {
      renderer = create(
        <ParcaeProvider client={asClient(client)} auth={auth}>
          <div>private route</div>
        </ParcaeProvider>,
      );
    });
    expect(client.session.state.userId).toBe("user-1");
    expect(currentRenderer().toJSON()).not.toBeNull();
    expect(throwingListener).toHaveBeenCalled();

    queryMocks.purge.mockClear();
    let refresh!: Promise<{ userId: string | null }>;
    await act(async () => {
      deferToken = true;
      refresh = client.refreshSession();
      await Promise.resolve();
    });

    expect(currentRenderer().toJSON()).toBeNull();
    expect(queryMocks.purge).toHaveBeenCalledWith(client, "user-1");

    await act(async () => {
      resolveToken("token-user-1");
      await refresh;
    });
    expect(client.session.state.userId).toBe("user-1");
    expect(currentRenderer().toJSON()).not.toBeNull();
  });

  it("purges the anonymous owner cache when an owned Provider unmounts", async () => {
    const client = new FakeClient();
    client.session.resolve(null);
    clientFactory.create.mockImplementation(() => asClient(client));

    await act(async () => {
      renderer = create(
        <ParcaeProvider url="https://api.example">
          <div>public route</div>
        </ParcaeProvider>,
      );
    });
    expect(currentRenderer().toJSON()).not.toBeNull();

    queryMocks.purge.mockClear();
    await act(async () => renderer?.unmount());
    renderer = null;

    expect(queryMocks.purge).toHaveBeenCalledWith(client, null);
  });

  it("reports an emitted-and-rejected Error once per reconciliation", async () => {
    const client = new FakeClient();
    const failure = new Error("token unavailable");
    client.refreshSession = vi.fn(async () => {
      client.emit("error", failure);
      throw failure;
    });
    let notifyAuthChange: (token: string | null) => void = () => undefined;
    const recurringAuth: AuthClientAdapter = {
      init: vi.fn(),
      getToken: vi.fn(async () => "token-user-2"),
      onChange: vi.fn((listener) => {
        notifyAuthChange = listener;
        return () => undefined;
      }),
    };
    const onError = vi.fn();

    await act(async () => {
      renderer = create(
        <ParcaeProvider
          client={asClient(client)}
          auth={recurringAuth}
          onError={onError}
        >
          <div>private route</div>
        </ParcaeProvider>,
      );
    });

    expect(currentRenderer().toJSON()).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);

    await act(async () => {
      notifyAuthChange("token-user-2");
    });
    expect(onError).toHaveBeenCalledTimes(2);

    await act(async () => {
      notifyAuthChange("token-user-2");
    });
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenLastCalledWith(failure);
  });

  it("isolates a throwing onError callback", async () => {
    const client = new FakeClient();
    const onError = vi.fn(() => {
      throw new Error("consumer callback failed");
    });

    await act(async () => {
      renderer = create(
        <ParcaeProvider client={asClient(client)} onError={onError}>
          <div>private route</div>
        </ParcaeProvider>,
      );
    });

    expect(() =>
      client.emit("error", new Error("transport failed")),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });
});
