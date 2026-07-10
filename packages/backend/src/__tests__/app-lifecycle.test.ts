import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const dbs: any[] = [];
  const pubsubs: any[] = [];
  const queues: any[] = [];
  const buses: any[] = [];
  const pollers: any[] = [];
  const servers: any[] = [];
  const offs: any[] = [];
  let listenError: Error | null = null;

  const knex = vi.fn(() => {
    const db = { destroy: vi.fn(async () => {}) };
    dbs.push(db);
    return db;
  });

  const PubSub = vi.fn().mockImplementation(function () {
    const pubsub = {
      building: Promise.resolve(),
      close: vi.fn(async () => {}),
      on: vi.fn(() => () => {}),
      emit: vi.fn(),
      tryLock: vi.fn(async () => true),
    };
    pubsubs.push(pubsub);
    return pubsub;
  });

  const QueueService = vi.fn().mockImplementation(function () {
    const queue = {
      building: Promise.resolve(),
      close: vi.fn(async () => {}),
      get: vi.fn(() => null),
      queueNameFor: vi.fn((name: string) => `parcae-${name}`),
      createWorker: vi.fn(),
    };
    queues.push(queue);
    return queue;
  });

  const ChangeBus = vi.fn().mockImplementation(function () {
    const off = vi.fn();
    const bus = {
      on: vi.fn(() => off),
      close: vi.fn(),
    };
    offs.push(off);
    buses.push(bus);
    return bus;
  });

  const ListenNotifyPoller = vi.fn().mockImplementation(function () {
    const poller = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    pollers.push(poller);
    return poller;
  });

  const createServer_ = vi.fn(() => {
    const polka: any = {};
    for (const method of ["use", "all", "get", "post", "put", "patch", "delete"]) {
      polka[method] = vi.fn(() => polka);
    }
    polka.handler = vi.fn();
    const io = {
      close: vi.fn((callback?: () => void) => callback?.()),
      on: vi.fn(),
      to: vi.fn(() => ({ emit: vi.fn() })),
      sockets: { sockets: new Map() },
    };
    const httpServer = {
      close: vi.fn((callback?: (err?: Error) => void) => callback?.()),
    };
    const server = { polka, io, httpServer };
    servers.push(server);
    return server;
  });

  const listenServer = vi.fn(async () => {
    if (listenError) throw listenError;
  });

  class BackendAdapter {
    engine = "postgres";
    modelsByType = new Map<string, any>();
    subscriptions: any = null;
    registerModels(models: any[]) {
      for (const model of models) this.modelsByType.set(model.type, model);
    }
    async detectEngine() {}
    async ensureAllTables() {}
    async batchFindByType() {
      return new Map();
    }
  }

  return {
    dbs,
    pubsubs,
    queues,
    buses,
    pollers,
    servers,
    offs,
    knex,
    PubSub,
    QueueService,
    ChangeBus,
    ListenNotifyPoller,
    BackendAdapter,
    createServer_,
    listenServer,
    setListenError(error: Error | null) {
      listenError = error;
    },
    reset() {
      dbs.length = 0;
      pubsubs.length = 0;
      queues.length = 0;
      buses.length = 0;
      pollers.length = 0;
      servers.length = 0;
      offs.length = 0;
      listenError = null;
      knex.mockClear();
      PubSub.mockClear();
      QueueService.mockClear();
      ChangeBus.mockClear();
      ListenNotifyPoller.mockClear();
      createServer_.mockClear();
      listenServer.mockClear();
    },
  };
});

vi.mock("knex", () => ({ default: mocks.knex }));
vi.mock("../schema/generate", () => ({
  generateSchemas: vi.fn(async () => ({ schemas: new Map(), cached: true })),
}));
vi.mock("../adapters/model", () => ({ BackendAdapter: mocks.BackendAdapter }));
vi.mock("../adapters/routes", () => ({ registerModelRoutes: vi.fn(() => 0) }));
vi.mock("../services/pubsub", () => ({ PubSub: mocks.PubSub }));
vi.mock("../services/queue", () => ({
  QueueService: mocks.QueueService,
  addJobIfNotExists: vi.fn(),
}));
vi.mock("../services/changeBus", () => ({ ChangeBus: mocks.ChangeBus }));
vi.mock("../services/listenNotifyPoller", () => ({
  ListenNotifyPoller: mocks.ListenNotifyPoller,
}));
vi.mock("../server", () => ({
  createServer_: mocks.createServer_,
  listenServer: mocks.listenServer,
}));

import {
  createApp,
  createSocketSessionController,
  mountAuthRoutes,
  normalizeModels,
  resyncQueries,
} from "../app";
import type { AuthSession } from "../auth";
import { getPubSub, getQueue } from "../services/context";

const claim = Symbol.for("@parcae/backend/app-start-claimed");

describe("application lifecycle", () => {
  beforeEach(() => {
    mocks.reset();
    delete (globalThis as any)[claim];
    vi.stubEnv("DATABASE_URL", "postgres://unused/test");
    vi.stubEnv("PARCAE_LISTEN_NOTIFY", "true");
    vi.stubEnv("ENSURE_SCHEMA", "false");
  });

  afterEach(() => {
    delete (globalThis as any)[claim];
    delete (globalThis as any).__parcae_adapter;
    vi.unstubAllEnvs();
  });

  it("cleans every acquired resource when listen startup fails", async () => {
    const bindError = Object.assign(new Error("address in use"), {
      code: "EADDRINUSE",
    });
    mocks.setListenError(bindError);
    const app = createApp({ models: [] });
    const start = app.start({ port: 4000 });
    const stop = app.stop();

    await expect(start).rejects.toBe(bindError);
    await expect(stop).resolves.toBeUndefined();
    expect(mocks.servers[0]!.io.close).toHaveBeenCalledTimes(1);
    expect(mocks.servers[0]!.httpServer.close).toHaveBeenCalledTimes(1);
    expect(mocks.offs[0]).toHaveBeenCalledTimes(1);
    expect(mocks.buses[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.pollers[0]!.start).toHaveBeenCalledTimes(1);
    expect(mocks.pollers[0]!.stop).toHaveBeenCalledTimes(1);
    expect(mocks.queues[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.pubsubs[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.dbs[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(getQueue()).toBeNull();
    expect(getPubSub()).toBeNull();
    await expect(app.start()).rejects.toThrow('lifecycle state is "failed"');
    await expect(createApp({ models: [] }).start()).rejects.toThrow(
      "app startup is one-shot",
    );
  });

  it("mounts auth at the exact base path and its wildcard once each", () => {
    const handler = vi.fn();
    const app = { all: vi.fn() };
    mountAuthRoutes(app, { basePath: "/webhooks/clerk", handler });

    const calls = app.all.mock.calls;
    expect(calls.map((call: any[]) => call[0])).toEqual([
      "/webhooks/clerk",
      "/webhooks/clerk/*",
    ]);
    expect(calls[0]![1]).toBe(calls[1]![1]);
  });
});

describe("socket hello session ordering", () => {
  it("keeps the newest resolved token when an older hello finishes last", async () => {
    let release!: (session: any) => void;
    const slow = new Promise<any>((resolve) => {
      release = resolve;
    });
    const auth = {
      resolveToken: vi.fn((token: string) =>
        token === "slow"
          ? slow
          : Promise.resolve({ user: { id: "u2", role: "admin" } }),
      ),
    };
    const subscriptions = { unsubscribeAll: vi.fn() };
    const controller = createSocketSessionController(
      "socket",
      auth as any,
      subscriptions,
    );
    const staleCallback = vi.fn();

    const stale = controller.hello({ token: "slow" }, staleCallback);
    await controller.hello({ token: "new" });
    release({ user: { id: "u1", role: "member" } });
    await stale;

    expect(controller.session).toEqual({
      user: { id: "u2", role: "admin" },
    });
    expect(staleCallback).toHaveBeenCalledWith({ userId: "u2" });
    expect(subscriptions.unsubscribeAll).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale token overwrite a newer signout", async () => {
    let release!: (session: any) => void;
    const auth = {
      resolveToken: vi.fn(
        () =>
          new Promise<any>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const controller = createSocketSessionController("socket", auth as any, {
      unsubscribeAll: vi.fn(),
    });

    const stale = controller.hello({ token: "slow" });
    await controller.hello({ token: null });
    release({ user: { id: "u1" } });
    await stale;

    expect(controller.session).toBeNull();
  });

  it("unsubscribes old claims before accepting changed claims", async () => {
    const sessions = new Map([
      ["member", { user: { id: "u1", role: "member" } }],
      ["admin", { user: { id: "u1", role: "admin" } }],
    ]);
    const auth = {
      resolveToken: vi.fn(async (token: string) => sessions.get(token) ?? null),
    };
    let controller: ReturnType<typeof createSocketSessionController>;
    const observed: Array<AuthSession | null> = [];
    controller = createSocketSessionController("socket", auth as any, {
      unsubscribeAll: () => observed.push(controller.session),
    });

    await controller.hello({ token: "member" });
    await controller.hello({ token: "member" });
    await controller.hello({ token: "admin" });

    expect(observed).toEqual([
      null,
      { user: { id: "u1", role: "member" } },
    ]);
  });
});

describe("model discovery normalization", () => {
  it("dedupes re-exported constructors and rejects distinct type collisions", () => {
    class Project {
      static type = "project";
    }
    class OtherProject {
      static type = "project";
    }

    expect(normalizeModels([Project as any, Project as any])).toEqual([Project]);
    expect(() =>
      normalizeModels([Project as any, OtherProject as any]),
    ).toThrow('same type "project"');
  });
});

describe("resyncQueries limits", () => {
  it("rejects oversized resync batches before doing query work", async () => {
    await expect(
      resyncQueries(
        "socket",
        null,
        [
          { key: "a", modelType: "thing", steps: [] },
          { key: "b", modelType: "thing", steps: [] },
        ],
        {} as any,
        { maxEntries: 1 },
      ),
    ).rejects.toThrow("Resync query limit exceeded (2/1)");
  });

  it("processes resync queries with bounded concurrency", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    let peak = 0;
    const makeQuery = () => {
      const query: any = {
        find: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await gate;
          inFlight--;
          return [];
        },
        count: async () => 0,
      };
      return query;
    };
    const Thing = {
      type: "thing",
      scope: { read: () => ({ allowed: true }) },
    };
    const adapter = {
      modelsByType: new Map([["thing", Thing]]),
      queryFromClient: vi.fn(() => makeQuery()),
      batchFindByType: vi.fn(async () => new Map()),
      subscriptions: null,
    };
    const entries = Array.from({ length: 6 }, (_, index) => ({
      key: String(index),
      modelType: "thing",
      steps: [],
      subscribe: false,
    }));

    const resync = resyncQueries("socket", null, entries, adapter as any, {
      concurrency: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peak).toBe(2);
    release();
    await expect(resync).resolves.toHaveLength(6);
    expect(peak).toBe(2);
  });

  it("returns explicit empty results for missing and denied models", async () => {
    const Denied = {
      type: "denied",
      scope: { read: () => null },
    };
    const NoRead = { type: "noRead", scope: {} };
    const adapter = {
      modelsByType: new Map([
        ["denied", Denied],
        ["noRead", NoRead],
      ]),
      batchFindByType: vi.fn(async () => new Map()),
      subscriptions: null,
    };

    await expect(
      resyncQueries(
        "socket",
        null,
        [
          { key: "missing-key", modelType: "missing", steps: [] },
          { key: "no-read-key", modelType: "noRead", steps: [] },
          { key: "denied-key", modelType: "denied", steps: [] },
        ],
        adapter as any,
      ),
    ).resolves.toEqual([
      { key: "missing-key", hash: null, items: [], totalCount: 0 },
      { key: "no-read-key", hash: null, items: [], totalCount: 0 },
      { key: "denied-key", hash: null, items: [], totalCount: 0 },
    ]);
  });
});
