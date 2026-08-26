import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let scanResult: any = { orphans: [], incomplete: false };
  const dbs: any[] = [];
  const pubsubs: any[] = [];
  const queues: any[] = [];
  const buses: any[] = [];
  const servers: any[] = [];

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
      get: vi.fn(() => ({})),
      queueNameFor: vi.fn(
        (name: string) => `parcae-${name.replace(/%/g, "%25").replace(/:/g, "%3A")}`,
      ),
      createWorker: vi.fn(),
      findOrphanQueues: vi.fn(async () => scanResult),
    };
    queues.push(queue);
    return queue;
  });

  const ChangeBus = vi.fn().mockImplementation(function () {
    const bus = {
      on: vi.fn(() => vi.fn()),
      onReconnect: vi.fn(() => vi.fn()),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    buses.push(bus);
    return bus;
  });

  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
  };

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
    async ensureChangeTriggers() {}
    async verifyChangeTriggers() {}
    async batchFindByType() {
      return new Map();
    }
  }

  return {
    queues,
    knex,
    PubSub,
    QueueService,
    ChangeBus,
    BackendAdapter,
    log,
    setScanResult(next: any) {
      scanResult = next;
    },
    createServer_,
    listenServer,
    reset() {
      dbs.length = 0;
      pubsubs.length = 0;
      queues.length = 0;
      buses.length = 0;
      servers.length = 0;
      knex.mockClear();
      PubSub.mockClear();
      QueueService.mockClear();
      ChangeBus.mockClear();
      createServer_.mockClear();
      listenServer.mockClear();
      scanResult = { orphans: [], incomplete: false };
      log.info.mockClear();
      log.warn.mockClear();
      log.error.mockClear();
      log.success.mockClear();
      log.debug.mockClear();
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
vi.mock("../services/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/queue")>()),
  QueueService: mocks.QueueService,
  addJobIfNotExists: vi.fn(),
}));
vi.mock("../services/change-bus", () => ({ ChangeBus: mocks.ChangeBus }));
vi.mock("../logger", () => ({ log: mocks.log }));
vi.mock("../server", () => ({
  createServer_: mocks.createServer_,
  listenServer: mocks.listenServer,
}));

import { createApp } from "../app";
import { clearJobs, job } from "../routing/job";

const claim = Symbol.for("@parcae/backend/app-start-claimed");

describe("orphan queue scan at boot", () => {
  beforeEach(() => {
    mocks.reset();
    clearJobs();
    delete (globalThis as any)[claim];
    vi.stubEnv("DATABASE_URL", "postgres://unused/test");
    vi.stubEnv("ENSURE_SCHEMA", "false");
    vi.stubEnv("RUN_JOBS", "true");
  });

  afterEach(() => {
    clearJobs();
    delete (globalThis as any)[claim];
    vi.unstubAllEnvs();
  });

  // A successful start() binds the process-wide model adapter, which has
  // no reset hook, so this file runs exactly one. The no-orphan and
  // incomplete-scan cases are covered by formatOrphanQueueWarning in
  // queue-orphan-scan.test.ts.
  it("scans with the registered queue names and warns with the orphan's counts", async () => {
    job("fax:extract", async () => {});
    mocks.setScanResult({
      orphans: [
        {
          queue: "parcae-fax-extract",
          wait: 3,
          paused: 0,
          active: 0,
          delayed: 0,
          prioritized: 0,
        },
      ],
      incomplete: false,
    });
    const app = createApp({ models: [] });
    await app.start({ port: 4101 });

    const queue = mocks.queues[0]!;
    expect(queue.findOrphanQueues).toHaveBeenCalledTimes(1);
    // The scan compares against QUEUE names. Passing the job name
    // ("fax:extract") instead of queueNameFor's output would leave every
    // live queue absent from the known set and reported as an orphan.
    expect(queue.findOrphanQueues).toHaveBeenCalledWith([
      "parcae-fax%3Aextract",
    ]);

    const warned = mocks.log.warn.mock.calls.map((c: any[]) => String(c[0]));
    const line = warned.find((m: string) => m.includes("parcae-fax-extract"));
    expect(line).toBeDefined();
    // The counts are the actionable part: they say work is stranded,
    // not merely that a stale key exists.
    expect(line).toContain("wait=3");
    await app.stop();
  });
});
