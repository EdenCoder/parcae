import { EventEmitter } from 'eventemitter3';
import { FrontendAdapter, Model } from '@parcae/model';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  async refreshSession(): Promise<{ userId: string | null }> {
    return { userId: this.session.state.userId };
  }

  async terminateSession(): Promise<void> {
    this.session.terminate();
  }

  disconnect(): void {}
  async reconnect(): Promise<void> {}
  dispose(): void {}
}

class Post extends Model {
  static type = 'post' as const;
  title = '';
}

function asClient(client: FakeClient): ParcaeClient {
  return client as unknown as ParcaeClient;
}

// The default binding is module-level state on the base Model class,
// so order matters inside this file: the opt-out test must run before
// anything binds.
describe('ParcaeProvider default model adapter', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    if (renderer) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
  });

  it('bindAdapter={false} leaves Model unbound', async () => {
    const client = new FakeClient();
    await act(async () => {
      renderer = create(
        <ParcaeProvider client={asClient(client)} bindAdapter={false}>
          <div />
        </ParcaeProvider>,
      );
    });
    expect(Model.hasAdapter()).toBe(false);
    expect(Post.hasAdapter()).toBe(false);
  });

  it('binds the client adapter by default so static factories work', async () => {
    const client = new FakeClient();
    await act(async () => {
      renderer = create(
        <ParcaeProvider client={asClient(client)}>
          <div />
        </ParcaeProvider>,
      );
    });
    expect(Post.hasAdapter()).toBe(true);
    expect(Post.getAdapter()).toBe(client.adapter);
    expect(() => Post.create({})).not.toThrow();
  });
});
