import { EventEmitter } from 'eventemitter3';
import { FrontendAdapter, Model } from '@parcae/model';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthClientAdapter } from '../auth-adapter';
import type { ParcaeClient } from '../client';
import { ConnectionMachine } from '../connection-machine';
import { ParcaeProvider } from '../react/Provider';
import { SessionMachine } from '../session-machine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class FakeClient extends EventEmitter {
  transport = this as any;
  adapter = new FrontendAdapter(this as any);
  session = new SessionMachine();
  connection = new ConnectionMachine();
  isConnected = true;
  get = vi.fn(async () => undefined as any);
  post = vi.fn(async () => undefined as any);
  put = vi.fn(async () => undefined as any);
  patch = vi.fn(async () => undefined as any);
  delete = vi.fn(async () => undefined as any);
  resync = vi.fn(async () => [] as any[]);

  bind<T extends typeof Model>(model: T): T {
    return model.bind(this.adapter);
  }

  confirmedToken: string | null = null;

  _lastConfirmedToken(): string | null {
    return this.confirmedToken;
  }

  refreshSession = vi.fn(async () => {
    if (this.session.state.status === 'terminated') this.session.reset();
    return { userId: this.session.state.userId };
  });

  terminateSession = vi.fn(async () => {
    this.session.terminate();
  });

  disconnect(): void {}
  async reconnect(): Promise<void> {}
  dispose(): void {}
}

function asClient(client: FakeClient): ParcaeClient {
  return client as unknown as ParcaeClient;
}

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function jwt(payload: object): string {
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

const USER_1 = { sub: 'user-1', sid: 'sess-1', org_id: 'org-1', org_role: 'org:member' };

/** Auth adapter whose `onChange` we can fire by hand. */
function controllableAuth(): AuthClientAdapter & { emit(token: string | null): void } {
  let listener: ((token: string | null) => void) | null = null;
  return {
    init: vi.fn(),
    getToken: vi.fn(async () => null),
    onChange(callback) {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    emit(token) {
      listener?.(token);
    },
  };
}

describe('ParcaeProvider auth token changes', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    if (renderer) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
  });

  async function mount(client: FakeClient, auth: AuthClientAdapter) {
    await act(async () => {
      renderer = create(
        <ParcaeProvider client={asClient(client)} url="http://x" auth={auth}>
          <div />
        </ParcaeProvider>,
      );
    });
  }

  it('leaves an anonymous session alone when the token reads null', async () => {
    const client = new FakeClient();
    client.session.resolve(null);
    const auth = controllableAuth();
    await mount(client, auth);

    await act(async () => auth.emit(null));

    // Terminating here would be a dead end: `useQuery` stops building
    // keys for a terminated session, so every mounted query would
    // report "loaded, zero rows" and pages render their not-found copy.
    expect(client.terminateSession).not.toHaveBeenCalled();
    expect(client.session.state.status).toBe('anonymous');
  });

  it('leaves a pending session alone when the token reads null', async () => {
    const client = new FakeClient();
    const auth = controllableAuth();
    await mount(client, auth);

    await act(async () => auth.emit(null));

    expect(client.terminateSession).not.toHaveBeenCalled();
    expect(client.session.state.status).toBe('pending');
  });

  it('terminates when a signed-in session loses its token', async () => {
    const client = new FakeClient();
    client.session.resolve('user-1');
    const auth = controllableAuth();
    await mount(client, auth);

    await act(async () => auth.emit(null));

    expect(client.terminateSession).toHaveBeenCalledTimes(1);
    expect(client.session.state.status).toBe('terminated');
  });

  it('refreshes on a non-null token', async () => {
    const client = new FakeClient();
    client.session.resolve(null);
    const auth = controllableAuth();
    await mount(client, auth);

    await act(async () => auth.emit('token-1'));

    expect(client.refreshSession).toHaveBeenCalledTimes(1);
    expect(client.terminateSession).not.toHaveBeenCalled();
  });

  // Short-lived JWTs rotate continuously. A rotation that changes no
  // authorization claim needs no hello: the socket session is already
  // authenticated and every future handshake re-reads the resolver. Refreshing
  // anyway re-runs the handshake and resyncs every subscription on a timer.
  it('skips the refresh when a rotation changes no authorization claim', async () => {
    const client = new FakeClient();
    client.session.resolve('user-1');
    client.confirmedToken = jwt({ ...USER_1, iat: 1000, exp: 1060 });
    const auth = controllableAuth();
    await mount(client, auth);

    await act(async () => auth.emit(jwt({ ...USER_1, iat: 1030, exp: 1090 })));

    expect(client.refreshSession).not.toHaveBeenCalled();
  });

  it('refreshes when a rotation carries a different authorization', async () => {
    const client = new FakeClient();
    client.session.resolve('user-1');
    client.confirmedToken = jwt({ ...USER_1, iat: 1000, exp: 1060 });
    const auth = controllableAuth();
    await mount(client, auth);

    await act(async () =>
      auth.emit(jwt({ ...USER_1, org_role: 'org:admin', iat: 1030, exp: 1090 })),
    );

    expect(client.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('refreshes an anonymous session even when the claims match', async () => {
    const client = new FakeClient();
    client.session.resolve(null);
    client.confirmedToken = jwt({ ...USER_1, iat: 1000, exp: 1060 });
    const auth = controllableAuth();
    await mount(client, auth);

    await act(async () => auth.emit(jwt({ ...USER_1, iat: 1030, exp: 1090 })));

    expect(client.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('refreshes when either token is not a decodable JWT', async () => {
    const client = new FakeClient();
    client.session.resolve('user-1');
    client.confirmedToken = 'opaque-session-token';
    const auth = controllableAuth();
    await mount(client, auth);

    await act(async () => auth.emit('opaque-session-token'));

    expect(client.refreshSession).toHaveBeenCalledTimes(1);
  });
});
