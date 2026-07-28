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
});
