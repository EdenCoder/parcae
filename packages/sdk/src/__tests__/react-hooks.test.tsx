import { EventEmitter } from 'eventemitter3';
import { FrontendAdapter, Model, SYM_SERVER_MERGE } from '@parcae/model';
import { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParcaeClient } from '../client';
import { ConnectionMachine } from '../connection-machine';
import { ParcaeProvider } from '../react/Provider';
import { useModelAtomic } from '../react/useModelAtomic';
import { useQuery, prefetch, __test as useQueryTest } from '../react/useQuery';
import { useSaving } from '../react/useSaving';
import { useSetting } from '../react/useSetting';
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

  subscribe(event: string, handler: (...args: any[]) => void): () => void {
    this.on(event, handler);
    return () => this.off(event, handler);
  }

  unsubscribe(event: string, handler?: (...args: any[]) => void): void {
    this.off(event, handler);
  }

  send(event: string, ...args: any[]): void {
    this.emit(event, ...args);
  }

  bind<T extends typeof Model>(model: T): T {
    return model.bind(this.adapter);
  }

  async refreshSession(): Promise<{ userId: string | null }> {
    return { userId: this.session.state.userId };
  }

  async terminateSession(): Promise<void> {
    this.session.terminate();
  }

  disconnect(): void {
    this.isConnected = false;
  }

  async reconnect(): Promise<void> {
    this.isConnected = true;
  }

  dispose(): void {
    this.emit('dispose');
  }
}

class Post extends Model {
  static type = 'post' as const;
  title = '';
}

interface BlockData {
  id: string;
  text: string;
  image?: { url: string };
}

class Project extends Model {
  static type = 'project' as const;
  blocks: Record<string, BlockData> = {};
  video = { url: '' };
}

function asClient(client: FakeClient): ParcaeClient {
  return client as unknown as ParcaeClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeChain(find: () => Promise<any[]>) {
  return {
    __modelType: 'post',
    __steps: [],
    __modelClass: null,
    __adapter: null,
    find,
  };
}

describe('mounted React SDK hooks', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    useQueryTest.resetCache();
  });

  afterEach(async () => {
    if (renderer) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
    useQueryTest.resetCache();
  });

  it('runs Provider readiness and anonymous cache purge for an external client', async () => {
    const fake = new FakeClient();
    const client = asClient(fake);
    const chain = makeChain(async () => [{ id: 'anonymous' }]);
    await prefetch(client, chain, { waitForSession: false, subscribe: false });
    const key = useQueryTest.buildKey('post', null, [], false);
    const onReady = vi.fn();

    await act(async () => {
      renderer = create(
        <ParcaeProvider client={client} onReady={onReady}>
          <div />
        </ParcaeProvider>,
      );
      fake.session.resolve(null);
    });

    expect(onReady).toHaveBeenCalledWith(client);
    const anonymousEntry = useQueryTest.getEntry(client, key)!;

    await act(async () => fake.session.resolve('user-1'));

    expect(useQueryTest.getEntry(client, key)).toBeUndefined();
    expect(anonymousEntry.gcTimer).toBeNull();
    await act(async () => renderer?.unmount());
    renderer = null;
    expect(fake.listenerCount('dispose')).toBeGreaterThan(0);
  });

  it('resets useSetting by user and ignores stale responses', async () => {
    const fake = new FakeClient();
    fake.session.resolve('user-a');
    const first = deferred<any>();
    const second = deferred<any>();
    fake.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let latest: [string, (value: string) => Promise<void>, { isLoading: boolean }];

    function Capture() {
      latest = useSetting('theme', 'default');
      return null;
    }

    await act(async () => {
      renderer = create(
        <ParcaeProvider client={asClient(fake)}>
          <Capture />
        </ParcaeProvider>,
      );
    });
    expect(latest![2].isLoading).toBe(true);

    await act(async () => fake.session.resolve('user-b'));
    expect(latest![0]).toBe('default');
    second.resolve({ value: 'from-b' });
    await act(async () => await second.promise);
    expect(latest![0]).toBe('from-b');

    first.resolve({ value: 'stale-a' });
    await act(async () => await first.promise);
    expect(latest![0]).toBe('from-b');
    expect(fake.get).toHaveBeenCalledTimes(2);
  });

  it('returns a boolean from useSaving through the model external store', async () => {
    const model = new EventEmitter() as EventEmitter & { __savingCount: number };
    model.__savingCount = 0;
    let latest: boolean | undefined;

    function Capture() {
      latest = useSaving(model);
      return null;
    }

    await act(async () => {
      renderer = create(<Capture />);
    });
    expect(latest).toBe(false);

    await act(async () => {
      model.__savingCount = 2;
      model.emit('__saving', 2);
    });
    expect(latest).toBe(true);
    expect(typeof latest).toBe('boolean');

    await act(async () => {
      model.__savingCount = 0;
      model.emit('__saving', 0);
    });
    expect(latest).toBe(false);
  });

  it('does not re-render a structurally unchanged atomic path after a server merge', async () => {
    const fake = new FakeClient();
    const project = Project.hydrate(fake.adapter, {
      id: 'project-1',
      blocks: {
        A: { id: 'A', text: 'alpha' },
        B: { id: 'B', text: 'beta' },
      },
    });
    let latest: BlockData | undefined;
    let renders = 0;

    function Capture() {
      renders++;
      latest = useModelAtomic<BlockData>(project, 'blocks.A');
      return null;
    }

    await act(async () => {
      renderer = create(<Capture />);
    });
    const initial = latest;

    await act(async () => {
      project[SYM_SERVER_MERGE]({
        id: 'project-1',
        blocks: {
          A: { id: 'A', text: 'alpha' },
          B: { id: 'B', text: 'beta', image: { url: '/new.png' } },
        },
      });
      await Promise.resolve();
    });

    expect(renders).toBe(1);
    expect(latest).toBe(initial);
  });

  it('renders a fresh atomic value merged after reconnect', async () => {
    const fake = new FakeClient();
    const project = Project.hydrate(fake.adapter, {
      id: 'project-1',
      video: { url: '/stale.mp4' },
    });
    let latest: string | undefined;
    let renders = 0;

    function Capture() {
      renders++;
      latest = useModelAtomic<string>(project, 'video.url');
      return null;
    }

    await act(async () => {
      renderer = create(<Capture />);
    });
    expect(latest).toBe('/stale.mp4');

    await act(async () => {
      project[SYM_SERVER_MERGE]({
        id: 'project-1',
        video: { url: '/fresh.mp4' },
      });
      await Promise.resolve();
    });

    expect(latest).toBe('/fresh.mp4');
    expect(renders).toBe(2);
  });

  it('honors an explicit atomic comparator override', async () => {
    const fake = new FakeClient();
    const project = Project.hydrate(fake.adapter, {
      id: 'project-1',
      blocks: { A: { id: 'A', text: 'alpha' } },
    });
    let latest: BlockData | undefined;
    let renders = 0;

    function Capture() {
      renders++;
      latest = useModelAtomic<BlockData>(project, 'blocks.A', Object.is);
      return null;
    }

    await act(async () => {
      renderer = create(<Capture />);
    });
    const initial = latest;

    await act(async () => {
      project[SYM_SERVER_MERGE]({
        id: 'project-1',
        blocks: { A: { id: 'A', text: 'alpha' } },
      });
      await Promise.resolve();
    });

    expect(renders).toBe(2);
    expect(latest).not.toBe(initial);
    expect(latest).toEqual(initial);
  });

  it('does not fetch a query after the session is terminated', async () => {
    const fake = new FakeClient();
    fake.session.terminate();
    const find = vi.fn(async () => []);
    let latest: any;

    function Capture() {
      latest = useQuery(makeChain(find), { poll: 0 });
      return null;
    }

    await act(async () => {
      renderer = create(
        <ParcaeProvider client={asClient(fake)}>
          <Capture />
        </ParcaeProvider>,
      );
    });

    expect(find).not.toHaveBeenCalled();
    expect(latest!.loading).toBe(false);
    expect(latest!.items).toEqual([]);
  });

  it('executes a legacy chain through the Provider client adapter', async () => {
    const source = new FakeClient();
    const provider = new FakeClient();
    source.session.resolve(null);
    provider.session.resolve(null);
    source.get.mockResolvedValue({ posts: [{ id: 'source', title: 'source' }] });
    provider.get.mockResolvedValue({
      posts: [{ id: 'provider', title: 'provider' }],
      __queryHash: 'provider-hash',
    });
    const chain = source.adapter.query(Post);
    let latest: any;

    function Capture() {
      latest = useQuery(chain, { poll: 0 });
      return null;
    }

    await act(async () => {
      renderer = create(
        <ParcaeProvider client={asClient(provider)}>
          <Capture />
        </ParcaeProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(source.get).not.toHaveBeenCalled();
    expect(provider.get).toHaveBeenCalledOnce();
    expect(latest.items[0].id).toBe('provider');
    expect(latest.items[0].constructor.getAdapter()).toBe(provider.adapter);

    await act(async () => {
      provider.emit('query:provider-hash', [
        {
          op: 'add',
          id: 'subscription',
          data: { id: 'subscription', title: 'subscription' },
        },
      ]);
    });
    expect(latest.items[1].constructor.getAdapter()).toBe(provider.adapter);

    const key = useQueryTest.buildKey('post', null, []);
    provider.resync.mockResolvedValueOnce([
      {
        key,
        hash: 'resynced-hash',
        items: [{ id: 'resynced', title: 'resynced' }],
        totalCount: 1,
      },
    ]);
    await act(async () => {
      provider.emit('resync-required');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest.items[0].id).toBe('resynced');
    expect(latest.items[0].constructor.getAdapter()).toBe(provider.adapter);
  });

  it('does not reuse a memoized result when the Provider client changes', async () => {
    const source = new FakeClient();
    const first = new FakeClient();
    const second = new FakeClient();
    first.session.resolve(null);
    second.session.resolve(null);
    first.get.mockResolvedValue({ posts: [{ id: 'same', title: 'first' }] });
    second.get.mockResolvedValue({ posts: [{ id: 'same', title: 'second' }] });
    const chain = source.adapter.query(Post);
    let latest: any;

    function Capture() {
      latest = useQuery(chain, { poll: 0, subscribe: false });
      return null;
    }

    await act(async () => {
      renderer = create(
        <ParcaeProvider client={asClient(first)}>
          <Capture />
        </ParcaeProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const firstResult = latest;
    expect(firstResult.items[0].title).toBe('first');

    await act(async () => {
      renderer?.update(
        <ParcaeProvider client={asClient(second)}>
          <Capture />
        </ParcaeProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest).not.toBe(firstResult);
    expect(latest.items[0].title).toBe('second');
    expect(first.get).toHaveBeenCalledOnce();
    expect(second.get).toHaveBeenCalledOnce();
  });

  it('fires onReady once per client through StrictMode effect replay', async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    first.session.resolve(null);
    second.session.resolve(null);
    const onReady = vi.fn();

    await act(async () => {
      renderer = create(
        <StrictMode>
          <ParcaeProvider client={asClient(first)} onReady={onReady}>
            <div />
          </ParcaeProvider>
        </StrictMode>,
      );
    });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenLastCalledWith(asClient(first));

    await act(async () => {
      renderer?.update(
        <StrictMode>
          <ParcaeProvider client={asClient(second)} onReady={onReady}>
            <div />
          </ParcaeProvider>
        </StrictMode>,
      );
    });
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenLastCalledWith(asClient(second));
  });

  it('shares one fetch and one drift timer across hook consumers', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fake = new FakeClient();
    fake.session.resolve(null);
    const find = vi.fn(async () => {
      const items: any[] = [{ id: 'p1' }];
      Object.defineProperty(items, '__totalCount', { value: 1 });
      return items;
    });
    const chain = makeChain(find);

    function Capture() {
      useQuery(chain, { poll: 100, subscribe: false });
      return null;
    }

    await act(async () => {
      renderer = create(
        <ParcaeProvider client={asClient(fake)}>
          <Capture />
          <Capture />
        </ParcaeProvider>,
      );
      await Promise.resolve();
    });

    const key = useQueryTest.buildKey('post', null, [], false);
    const entry = useQueryTest.getEntry(asClient(fake), key)!;
    expect(find).toHaveBeenCalledTimes(1);
    expect(entry.refs).toBe(2);
    expect(entry.pollConsumers.size).toBe(2);
    expect(entry.pollTimer).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(find).toHaveBeenCalledTimes(2);
    expect(entry.pollTimer).not.toBeNull();

    await act(async () => renderer?.unmount());
    renderer = null;
    expect(entry.pollTimer).toBeNull();
    fake.dispose();
    expect(useQueryTest.getEntry(asClient(fake), key)).toBeUndefined();
  });
});
