/**
 * @parcae/backend — createApp()
 *
 * The main entry point for a Parcae backend application.
 * Handles the full startup sequence: .parcae/ generation, database connection,
 * model registration, auto-CRUD routes, controller/hook/job discovery,
 * and HTTP + WebSocket server startup.
 */

import { resolve, join } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import pako from "pako";
import { compress } from "compress-json";
import equal from "deep-equal";
import pluralize from "pluralize";
import { createSocketFakeRes } from "./socket-fake-res";
import { Model } from "@parcae/model";
import type { ModelConstructor, SchemaDefinition } from "@parcae/model";
import { log } from "./logger";
import { ClientError } from "./helpers";
import { generateSchemas } from "./schema/generate";
import {
  parseConfig,
  isSqliteUrl,
  sqliteFilename,
  resolveRuntimeFlags,
} from "./config";
import type { Config, RuntimeFlags } from "./config";
import { createServer_, listenServer } from "./server";
import type { ServerContext } from "./server";
import {
  getRoutes,
  getSocketHandlers,
  runSocketChain,
  wrapHttpHandler,
  type Middleware,
  type SocketContext,
} from "./routing/route";
import { BackendAdapter } from "./adapters/model";
import { registerModelRoutes } from "./adapters/routes";
import { PubSub } from "./services/pubsub";
import { QueueService } from "./services/queue";
import { RefLoader } from "./services/ref-loader";
import {
  QuerySubscriptionManager,
  parsePositiveInteger,
} from "./services/subscriptions";
import { ChangeBus } from "./services/changeBus";
import { ListenNotifyPoller } from "./services/listenNotifyPoller";
import {
  _setServices,
  _setIo,
  _setChangeBus,
  _setRuntimeFlags,
  _clearServices,
  runWithRequestContext,
} from "./services/context";
import {
  prepareClientQuery,
  runQuerySubscription,
  runQueryStatic,
} from "./services/query-subscription";
import { getJobs } from "./routing/job";
import { getHooks } from "./routing/hook";
import { getCrons } from "./routing/cron";
import type { CronEntry } from "./routing/cron";
import { Cron } from "croner";
import { getMigrations } from "./routing/migration";
import { runMigrations } from "./adapters/migrations";
import { discoverMigrations } from "./adapters/migration-discovery";
import type { AuthAdapter, AuthSession } from "./auth";
import knex from "knex";
import { shutdownResources } from "./shutdown";
import type { ShutdownResources } from "./shutdown";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface AppConfig {
  /** Model classes or directory path for auto-discovery. */
  models: ModelConstructor[] | string;
  /** Controllers directory for auto-discovery. */
  controllers?: string;
  /** Hooks directory for auto-discovery. */
  hooks?: string;
  /** Jobs directory for auto-discovery. */
  jobs?: string;
  /**
   * Crons directory for auto-discovery. Files self-register via `cron()`
   * at import time. Crons are local (in-process) scheduled tasks — not
   * BullMQ jobs — so they fire wherever `RUN_CRONS` is enabled, with
   * cross-process deduplication via distributed try-lock at fire time.
   */
  crons?: string;
  /**
   * Migrations directory for auto-discovery. Files are loaded at startup and
   * self-register via `migration()`. Runs in lexicographic order, before
   * `ensureAllTables()`. See routing/migration.ts for the full contract.
   */
  migrations?: string;
  /** Authentication adapter. Opt-in — omit to skip auth entirely. */
  auth?: AuthAdapter;
  /**
   * App-wide HTTP middleware. Mounted after auth/session resolution and the
   * per-request Parcae context, before health, auto-CRUD, and custom routes.
   * Socket RPC calls pass through the same middleware chain via the fake
   * request path.
   */
  middleware?: Middleware[];
  /** API version prefix. Default: "v1" */
  version?: string;
  /** Project root directory. Default: process.cwd() */
  root?: string;
  /**
   * Path to the models package (where tsconfig.json + model sources live).
   * Used by the ts-morph schema resolver at startup. Can be absolute or
   * relative to root. If not set, auto-detected from common monorepo
   * locations.
   */
  modelsPath?: string;
  /**
   * Optional callback fired AFTER each authenticated request has its
   * session resolved (or pre-injected for socket-RPC), and BEFORE
   * route dispatch. Errors are caught and logged so a faulty hook
   * cannot break the request path. Sync or async — sockets/HTTP both
   * fire the same hook.
   *
   * Two main uses:
   *   1. Telemetry / audit. Return a Promise; async work runs as
   *      fire-and-forget without blocking the request. Do not write
   *      to `res`.
   *   2. Step-up / kill-switch enforcement. Write a response to `res`
   *      synchronously (e.g. via `error(res, 403, ...)`). When
   *      `res.writableEnded` is true after the hook returns, the
   *      framework short-circuits — the route is not dispatched.
   *      Control-flow uses must finish writing before the hook
   *      returns; async writes can't short-circuit.
   */
  onAuthenticatedRequest?: (
    req: any,
    session: AuthSession | null,
    res: any,
  ) => void | Promise<void>;
  /**
   * Per-socket subscription cap. Defaults to 500 (see
   * `DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET` in
   * `services/subscriptions.ts`). Bump higher for apps with very
   * subscription-heavy navigation (the client SDK keeps each query
   * warm for ~60s after unmount, so deep clicks-per-minute can pile
   * distinct hashes against a single socket). The
   * `PARCAE_MAX_SUBSCRIPTIONS_PER_SOCKET` env var overrides this if
   * set.
   *
   * Hitting the cap is normally a runaway-render-loop signal — the
   * server log warns loudly when it fires. If you legitimately need
   * more, raise this; don't disable.
   */
  maxSubscriptionsPerSocket?: number;
}

export interface ParcaeApp {
  /** Start the server. */
  start(options?: { dev?: boolean; port?: number }): Promise<void>;
  /** Stop the server gracefully. */
  stop(): Promise<void>;
  /** Resolved model schemas. Available after start(). */
  schemas: Map<string, SchemaDefinition>;
  /** Loaded model constructors. Available after start(). */
  models: ModelConstructor[];
}

// ─── Model discovery ─────────────────────────────────────────────────────────

/**
 * Auto-discover model classes from a directory.
 * Imports all .ts/.js files and extracts default exports that have `static type`.
 */
async function discoverModels(dir: string): Promise<ModelConstructor[]> {
  const absDir = resolve(dir);
  if (!existsSync(absDir)) {
    log.warn(`Models directory not found: ${absDir}`);
    return [];
  }

  const models: ModelConstructor[] = [];
  const entries = readdirSync(absDir, { withFileTypes: true });

  for (const dirent of entries) {
    if (!dirent.isFile()) continue;
    const name = dirent.name;
    if (!name.endsWith(".ts") && !name.endsWith(".js")) continue;
    if (name.startsWith(".") || name.startsWith("_")) continue;

    const filePath = join(absDir, name);
    try {
      const mod = await import(filePath);
      // Check all exports for Model constructors — anything with a
      // `static type` string is treated as a parcae model. We
      // narrow via a property check instead of a generic type guard
      // because the imported module is `unknown` at this point.
      for (const exported of Object.values(mod)) {
        if (typeof exported !== "function") continue;
        const candidate = exported as { type?: unknown };
        if (typeof candidate.type === "string" && candidate.type.length > 0) {
          models.push(exported as ModelConstructor);
        }
      }
    } catch (err) {
      log.warn(
        `Failed to import model from ${name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return models;
}

/** Dedupe re-exported constructors and reject ambiguous model type ownership. */
export function normalizeModels(
  discovered: readonly ModelConstructor[],
): ModelConstructor[] {
  const constructors = new Set<ModelConstructor>();
  const byType = new Map<string, ModelConstructor>();
  const models: ModelConstructor[] = [];

  for (const model of discovered) {
    if (constructors.has(model)) continue;
    const existing = byType.get(model.type);
    if (existing && existing !== model) {
      throw new Error(
        `Distinct model constructors declare the same type "${model.type}"`,
      );
    }
    constructors.add(model);
    byType.set(model.type, model);
    models.push(model);
  }
  return models;
}

// ─── Auto-discovery ──────────────────────────────────────────────────────────

/**
 * Auto-discover and import all .ts/.js files from a directory (recursively).
 * Files self-register by calling route.*, hook.*, job(), cron() at import
 * time. Like Next.js — just put files in the directory, they're auto-loaded.
 *
 * The cache (second arg) survives across multiple discoverAndImport calls
 * so we don't import the same canonical file twice when the same physical
 * file shows up via different scans — e.g. when `hooks/foo.ts` does a
 * side-effect import of `jobs/asset/bar.ts` and we then scan `jobs/`
 * directly. tsx's path normalisation is just inconsistent enough that
 * Node's own module cache can't catch this; carrying our own canonical-
 * path Set is the cheap defensive fix.
 */
async function discoverAndImport(
  dir: string,
  label: string,
  importedFiles: Set<string>,
): Promise<number> {
  const absDir = resolve(dir);
  if (!existsSync(absDir)) return 0;

  let count = 0;
  const entries = readdirSync(absDir, { recursive: true, withFileTypes: true });

  for (const dirent of entries) {
    if (!dirent.isFile()) continue;
    const name = dirent.name;
    if (!name.endsWith(".ts") && !name.endsWith(".js")) continue;
    if (name.startsWith(".") || name.startsWith("_")) continue;
    if (dirent.parentPath.includes("node_modules")) continue;
    if (name === "index.ts" || name === "index.js") continue;

    const filePath = join(dirent.parentPath, name);

    if (importedFiles.has(filePath)) {
      // Already imported (probably via a side-effect chain from an
      // earlier scan). Skip the redundant import — re-importing isn't
      // a no-op for files whose side effects include registry pushes
      // (`job()`, `hook()`, `cron()`), and tsx's module cache doesn't
      // always dedupe imports keyed by different absolute paths that
      // resolve to the same canonical file.
      continue;
    }
    importedFiles.add(filePath);

    try {
      await import(filePath);
      count++;
    } catch (err) {
      log.warn(
        `Failed to import ${label} from ${name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return count;
}

// ─── Cron scheduling ─────────────────────────────────────────────────────────

/**
 * Start a single registered cron with cross-process deduplication.
 *
 * croner fires the trigger on every process that has `RUN_CRONS=true`. To
 * avoid running the same handler N times per tick when there's an N-wide
 * worker fleet, every contender attempts a non-blocking `tryLock` keyed
 * on the cron name + the planned fire timestamp (millisecond-rounded).
 * Exactly one process wins per tick via Redis SET NX EX; the others
 * silently bail before invoking the handler.
 *
 * `entry.options.overlap` (default `false`) propagates to croner's
 * `protect` so a slow handler doesn't stack ticks even if the lock dance
 * lets two processes race past the SETNX boundary (shouldn't happen, but
 * belt-and-suspenders).
 */
function startCron(entry: CronEntry, pubsub: PubSub): Cron {
  const protectPrev = entry.options.overlap !== true;
  return new Cron(
    entry.pattern,
    {
      protect: protectPrev,
      timezone: entry.options.timezone,
    },
    async () => {
      // Round to the nearest second so contending processes hash the same
      // tick window even with mild clock skew. The lock key includes the
      // pattern so multiple crons that happen to share names across
      // versions don't collide.
      const tickMs = Math.floor(Date.now() / 1000) * 1000;
      const lockKey = `cron:tick:${entry.name}:${tickMs}`;
      // Hold the dedup key longer than any reasonable tick to absorb
      // clock drift, capped at 5 minutes so a stuck process doesn't
      // wedge the schedule forever.
      const ttlMs = 5 * 60 * 1000;
      let acquired = true;
      try {
        acquired = await pubsub.tryLock(lockKey, ttlMs);
      } catch (err) {
        log.warn(
          `[cron:${entry.name}] tryLock failed (${(err as Error).message}); ` +
            `firing anyway — duplicate execution possible`,
        );
      }
      if (!acquired) return;

      const fireDate = new Date();
      try {
        await entry.handler({
          data: { name: entry.name, pattern: entry.pattern, fireDate },
        });
      } catch (err) {
        log.error(
          `[cron:${entry.name}] handler threw: ${(err as Error).message}`,
        );
        // Don't rethrow — croner would silently swallow it anyway, and
        // we want the schedule to keep firing on the next tick.
      }
    },
  );
}

// ─── Socket helpers ──────────────────────────────────────────────────────────

interface ResyncEntry {
  key: string;
  modelType: string;
  steps: unknown[];
  queryHash?: string | null;
  subscribe?: boolean;
}

interface ResyncOptions {
  maxEntries?: number;
  concurrency?: number;
}

const DEFAULT_MAX_RESYNC_QUERIES = 100;
const DEFAULT_RESYNC_CONCURRENCY = 8;

interface SocketSessionSubscriptions {
  unsubscribeAll(socketId: string): void;
}

export function createSocketSessionController(
  socketId: string,
  authAdapter: AuthAdapter | null,
  subscriptions: SocketSessionSubscriptions,
) {
  let session: AuthSession | null = null;
  let generation = 0;

  return {
    get session(): AuthSession | null {
      return session;
    },
    async hello(
      payload: { token?: string | null } | null | undefined,
      callback?: (result: { userId: string | null }) => void,
    ): Promise<void> {
      const acceptedGeneration = ++generation;
      const token = payload?.token ?? null;
      let nextSession: AuthSession | null = null;
      if (authAdapter && token) {
        try {
          nextSession = await authAdapter.resolveToken(token);
        } catch {
          nextSession = null;
        }
      }

      if (acceptedGeneration !== generation) {
        callback?.({ userId: session?.user?.id ?? null });
        return;
      }
      if (!equal(session, nextSession, { strict: true })) {
        subscriptions.unsubscribeAll(socketId);
        session = nextSession;
      }
      callback?.({ userId: session?.user?.id ?? null });
    },
  };
}

export function mountAuthRoutes(
  app: { all(path: string, handler: Middleware): unknown },
  routes: NonNullable<AuthAdapter["routes"]>,
): void {
  const basePath = routes.basePath.replace(/\/+$/, "") || "/";
  const handler = wrapHttpHandler(routes.handler);
  app.all(basePath, handler);
  app.all(basePath === "/" ? "/*" : `${basePath}/*`, handler);
}

export async function resyncQueries(
  socketId: string,
  socketSession: AuthSession | null,
  entries: ResyncEntry[],
  adapter: BackendAdapter,
  options: ResyncOptions = {},
): Promise<Array<{ key: string; hash: string | null; items: any[]; totalCount: number }>> {
  const maxEntries = parsePositiveInteger(
    options.maxEntries ?? DEFAULT_MAX_RESYNC_QUERIES,
    "maxEntries",
  )!;
  const concurrency = parsePositiveInteger(
    options.concurrency ?? DEFAULT_RESYNC_CONCURRENCY,
    "concurrency",
  )!;
  if (entries.length > maxEntries) {
    throw new ClientError(
      `Resync query limit exceeded (${entries.length}/${maxEntries})`,
      400,
    );
  }

  const results: Array<{
    key: string;
    hash: string | null;
    items: any[];
    totalCount: number;
  }> = entries.map((entry) => ({
    key: entry.key,
    hash: null,
    items: [],
    totalCount: 0,
  }));
  const user = socketSession?.user ?? null;
  let nextIndex = 0;

  const run = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= entries.length) return;
      const entry = entries[index]!;
      const refLoader = new RefLoader((type, ids) =>
        adapter.batchFindByType(type, ids),
      );
      results[index] = await runWithRequestContext(
        { user, refLoader },
        async () => {
          const ModelClass = adapter.modelsByType.get(entry.modelType);
          if (!ModelClass) return results[index]!;
          const scope = (ModelClass as any).scope;
          if (!scope?.read) return results[index]!;

          const scopeResult = scope.read({ user, params: {}, data: {} } as any);
          if (!scopeResult) return results[index]!;

          const prep = prepareClientQuery({
            ModelClass,
            scopeResult,
            rawSteps: entry.steps,
            modelByType: adapter.modelsByType,
            adapter,
          });

          if (entry.subscribe === false) {
            const { items, totalCount } = await runQueryStatic({
              prep,
              user,
              adapter,
            });
            return { key: entry.key, hash: null, items, totalCount };
          }

          if (!adapter.subscriptions) return results[index]!;
          const { items, hash, totalCount } = await runQuerySubscription({
            prep,
            socketId,
            user,
            adapter,
          });
          return { key: entry.key, hash, items, totalCount };
        },
      );
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, entries.length) },
      () => run(),
    ),
  );
  return results;
}

// ─── createApp ───────────────────────────────────────────────────────────────

type AppState =
  | "idle"
  | "starting"
  | "started"
  | "stopping"
  | "stopped"
  | "failed";

const APP_START_CLAIM = Symbol.for("@parcae/backend/app-start-claimed");

function claimApplication(): void {
  const globals = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
  if (globals[APP_START_CLAIM]) {
    throw new Error(
      "A Parcae application has already started in this process; app startup is one-shot",
    );
  }
  globals[APP_START_CLAIM] = true;
}

function clearApplicationContext(): void {
  _clearServices();
}

export function createApp(config: AppConfig): ParcaeApp {
  const version = config.version ?? "v1";
  const projectRoot = resolve(config.root ?? process.cwd());

  let schemas = new Map<string, SchemaDefinition>();
  let models: ModelConstructor[] = [];
  let server: ServerContext | null = null;
  let envConfig: Config | null = null;
  let flags: RuntimeFlags | null = null;
  let teardown: ShutdownResources | null = null;
  let state: AppState = "idle";
  let transition = Promise.resolve();

  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const run = transition.then(operation, operation);
    transition = run.catch(() => {});
    return run;
  };

  return {
    get schemas() {
      return schemas;
    },
    get models() {
      return models;
    },

    async start(options = {}) {
      return serialize(async () => {
        if (state !== "idle") {
          throw new Error(
            `Cannot start Parcae app while lifecycle state is "${state}"`,
          );
        }
        claimApplication();
        state = "starting";
        const resources: ShutdownResources = {};
        teardown = resources;

        try {
      // ── Step 0: Parse & validate config ────────────────────────────
      envConfig = parseConfig(process.env, projectRoot);
      const port = options.port ?? envConfig.PORT;
      const dev = options.dev ?? envConfig.NODE_ENV === "development";

      // Resolve per-process runtime flags from RUN_SERVER / RUN_HOOKS /
      // RUN_JOBS / RUN_CRONS. The rest of startup only consults `flags`.
      // We also publish them into the service context so downstream
      // code (e.g. BackendAdapter.runHooks) can branch on them.
      flags = resolveRuntimeFlags(envConfig);
      _setRuntimeFlags(flags);

      const jobsLabel =
        flags.jobs === true
          ? "all"
          : flags.jobs === false
            ? "none"
            : `[${[...flags.jobs].join(", ")}]`;
      log.info(
        `Starting${dev ? " (dev mode)" : ""} — ` +
          `server=${flags.server} hooks=${flags.hooks} jobs=${jobsLabel}`,
      );

      // ── Step 1: Discover models ────────────────────────────────────
      if (Array.isArray(config.models)) {
        models = normalizeModels(config.models);
      } else {
        models = normalizeModels(await discoverModels(config.models));
      }
      log.info(
        `Found ${models.length} model(s): ${models.map((m) => m.type).join(", ")}`,
      );

      // ── Step 2: Generate schemas (.parcae/) ────────────────────────
      const result = await generateSchemas(models, {
        projectRoot,
        modelsPath: config.modelsPath,
        force: false,
        dev,
      });
      schemas = result.schemas;

      log.info(
        `Resolved schemas for: ${[...schemas.keys()].join(", ")}` +
          (result.cached ? " (cached)" : " (resolved)"),
      );

      // ── Step 2.5: Discover migrations ───────────────────────────────
      // Migrations live in their own directory and are discovered separately
      // from controllers/hooks/jobs because they need to be registered
      // before the DB connection opens (so we know how many exist) and run
      // before ensureAllTables() (so renames happen before the additive
      // pass creates parallel empty tables). Each entry is tagged with its
      // source file path so checksum verification can detect drift later.
      if (config.migrations) {
        const discovered = await discoverMigrations(config.migrations);
        log.info(`Discovered ${discovered.length} migration file(s)`);
      }

      // ── Step 3: Connect database ───────────────────────────────────
      const useSqlite = isSqliteUrl(envConfig.DATABASE_URL);

      let writeDb: ReturnType<typeof knex>;
      let readDb: ReturnType<typeof knex>;

      // Postgres connection-pool size. The prior hardcoded max of 10 was
      // exhausted when many scheduled jobs fired in the same minute on the
      // daemon (which runs every job worker concurrently), so acquiring a
      // connection timed out. Default raised to 25 so the fix does not
      // depend on setting an env; DB_POOL_MAX overrides it per-deployment.
      const dbPoolMax = Math.max(2, Number(process.env.DB_POOL_MAX) || 25);

      if (useSqlite) {
        const filename = sqliteFilename(envConfig.DATABASE_URL);
        writeDb = knex({
          client: "better-sqlite3",
          connection: { filename },
          useNullAsDefault: true,
        });
        resources.writeDb = writeDb;
        readDb = writeDb; // SQLite has no read replica
        resources.readDb = readDb;
        log.info(`SQLite database: ${filename}`);
      } else {
        writeDb = knex({
          client: "pg",
          connection: envConfig.DATABASE_URL,
          pool: { min: 2, max: dbPoolMax },
        });
        resources.writeDb = writeDb;
        if (envConfig.DATABASE_READ_URL) {
          readDb = knex({
            client: "pg",
            connection: envConfig.DATABASE_READ_URL,
            pool: { min: 2, max: dbPoolMax },
          });
        } else {
          readDb = writeDb;
        }
        resources.readDb = readDb;
      }

      log.info("Database connected");

      // ── Step 4: Connect Redis (PubSub + Queue) ─────────────────────
      log.info("Connecting PubSub...");
      const pubsub = new PubSub({ url: envConfig.REDIS_URL });
      resources.pubsub = pubsub;
      await pubsub.building;
      log.info("PubSub ready");

      log.info("Connecting Queue...");
      const queue = new QueueService({
        url: envConfig.REDIS_URL,
        name: envConfig.JOB_QUEUE_NAME || "parcae",
      });
      resources.queue = queue;
      await queue.building;
      log.info("Queue ready");

      // Make queue + pubsub available globally via enqueue() and lock()
      _setServices(queue, pubsub);

      if (envConfig.REDIS_URL) {
        log.info("Redis connected (PubSub + Queue)");
      } else {
        log.info("Redis not configured — using in-process fallbacks");
      }

      // ── Step 4.5: ChangeBus (model-change fan-out) ─────────────────
      // Single structured event bus over PubSub. _notifyChange in the
      // adapter publishes here; QuerySubscriptionManager listens
      // (wired below). One bus per app; close()'d at shutdown.
      const changeBus = new ChangeBus({ pubsub });
      resources.changeBus = changeBus;
      _setChangeBus(changeBus);

      // ── Step 5: Set up BackendAdapter + Model.use() ────────────────
      const adapter = new BackendAdapter({
        read: readDb,
        write: writeDb,
        pubsub,
        changeBus,
      });
      adapter.registerModels(models);
      Model.use(adapter);

      // Detect database engine (SQLite / Postgres / AlloyDB)
      log.info("Detecting database engine...");
      await adapter.detectEngine(useSqlite ? "sqlite" : undefined);
      log.info("Database engine detected");

      // ── Step 6: Set up auth (opt-in) ───────────────────────────────
      // Auth runs BEFORE ensureAllTables so that auth-owned tables
      // (users, sessions, accounts, verifications) are created first.
      // Parcae's ensureAllTables then adds any custom columns to the
      // users table and creates app-specific tables.
      const authAdapter: AuthAdapter | null = config.auth ?? null;
      const ensureSchema = process.env.ENSURE_SCHEMA === "true";

      if (authAdapter) {
        resources.auth = authAdapter;
        const userModel = models.find((m) => m.type === "user") ?? null;

        await authAdapter.setup({
          userModel,
          adapter,
          config: envConfig,
          db: writeDb,
          ensureSchema,
        });

        log.info("Auth enabled");
      }

      // ── Step 6.5: Run user migrations ──────────────────────────────
      // Runs BEFORE ensureAllTables() so that renames/type-changes happen
      // before the additive schema pass would otherwise create parallel
      // empty tables next to legacy ones. Gated on ENSURE_SCHEMA for
      // parity with Better Auth migrations and ensureAllTables below —
      // operators who prefer out-of-band migration runs (via `parcae
      // migrate:latest`) can disable.
      if (ensureSchema) {
        const migrations = getMigrations();
        const allowChecksumDrift =
          process.env.PARCAE_ALLOW_CHECKSUM_DRIFT === "true";
        await runMigrations({
          db: writeDb,
          entries: migrations,
          engine: adapter.engine,
          adapter,
          allowChecksumDrift,
        });
      }

      // ── Step 7: Ensure tables (additive migration) ─────────────────
      if (ensureSchema) {
        await adapter.ensureAllTables(models);
        log.info("Database schema ensured");
      }

      // ── Step 8: Create server ──────────────────────────────────────
      server = createServer_({ config: envConfig, version });
      resources.io = server.io;
      resources.httpServer = server.httpServer;
      _setIo(server.io);

      // ── Step 9: Set up QuerySubscriptionManager ────────────────────
      // The IO backend wires Socket.IO rooms: every subscriber for a
      // given cached query joins `query:${hash}` at
      // subscribe time so re-eval can broadcast ONCE via `io.to(room)`
      // instead of N times via `io.to(socketId)`. The legacy
      // `emitToSocket` is still provided as a fallback for any path
      // that doesn't have a room (e.g. force-refresh on a query the
      // socket hasn't joined yet).
      const reevalConcurrency = parsePositiveInteger(
        process.env.PARCAE_REEVAL_CONCURRENCY,
        "PARCAE_REEVAL_CONCURRENCY",
      );
      const maxSubscriptionsPerSocket = parsePositiveInteger(
        process.env.PARCAE_MAX_SUBSCRIPTIONS_PER_SOCKET ??
          config.maxSubscriptionsPerSocket,
        "PARCAE_MAX_SUBSCRIPTIONS_PER_SOCKET",
      );
      const maxResyncQueries = parsePositiveInteger(
        process.env.PARCAE_MAX_RESYNC_QUERIES,
        "PARCAE_MAX_RESYNC_QUERIES",
      ) ?? DEFAULT_MAX_RESYNC_QUERIES;
      const resyncConcurrency = parsePositiveInteger(
        process.env.PARCAE_RESYNC_CONCURRENCY,
        "PARCAE_RESYNC_CONCURRENCY",
      ) ?? DEFAULT_RESYNC_CONCURRENCY;
      const subscriptions = new QuerySubscriptionManager(
        {
          emitToSocket: (socketId, event, data) => {
            server?.io.to(socketId).emit(event, data);
          },
          emitToRoom: (room, event, data) => {
            server?.io.to(room).emit(event, data);
          },
          joinRoom: (socketId, room) => {
            const socket = server?.io.sockets.sockets.get(socketId);
            // The socket may have disconnected between the HTTP
            // subscribe call landing and this hook firing. Skip
            // silently — the room broadcast won't reach a missing
            // socket either way, and `unsubscribe` will GC the
            // cached query when its subscriber count hits zero.
            socket?.join(room);
          },
          leaveRoom: (socketId, room) => {
            const socket = server?.io.sockets.sockets.get(socketId);
            socket?.leave(room);
          },
        },
        {
          ...(reevalConcurrency !== undefined ? { reevalConcurrency } : {}),
          ...(maxSubscriptionsPerSocket !== undefined
            ? { maxSubscriptionsPerSocket }
            : {}),
        },
      );
      adapter.subscriptions = subscriptions;

      // ChangeBus → manager: every Change (hook-path or LISTEN-path)
      // triggers a debounced re-eval for every cached query watching
      // that table. The bus is per-process; PubSub fans across
      // processes underneath it. Tracked so we can dispose on close.
      const offChange = changeBus.on((change) => {
        // ChangeBus carries DB table names because LISTEN/NOTIFY
        // payloads originate from Postgres triggers (`projectAssets`).
        // QuerySubscriptionManager indexes subscriptions by Model.type
        // (`projectAsset`). Convert at the boundary so hook-path and
        // trigger-path events hit the same index.
        const modelType = pluralize.singular(change.table);
        subscriptions.onModelChange(modelType);
      });
      resources.offChange = offChange;

      // ── Step 9.5: LISTEN/NOTIFY poller (Postgres only) ─────────────
      // Captures external writes that bypass Parcae's adapter (raw
      // SQL, migrations, ops console). Installs trigger DDL during
      // ensureAllTables above; the poller subscribes via a dedicated
      // pg client and emits Changes onto the bus with `source: "listen"`.
      // Echoes of our own hook-path emits are deduped by request-id.
      const listenNotifyEnabled =
        adapter.engine !== "sqlite" &&
        process.env.PARCAE_LISTEN_NOTIFY !== "false";
      let listenNotify: ListenNotifyPoller | null = null;
      if (listenNotifyEnabled && envConfig.DATABASE_URL) {
        listenNotify = new ListenNotifyPoller({
          url: envConfig.DATABASE_URL,
          changeBus,
        });
        resources.listenNotify = listenNotify;
        try {
          await listenNotify.start();
          log.info("LISTEN/NOTIFY poller started");
        } catch (err) {
          log.warn(
            `LISTEN/NOTIFY poller failed to start (continuing without external-write capture): ${
              (err as Error).message
            }`,
          );
          await listenNotify.stop();
          listenNotify = null;
          resources.listenNotify = null;
        }
      }
      resources.crons = [];

      // ── Step 10: Mount auth routes + middleware ─────────────────────
      if (authAdapter) {
        if (authAdapter.routes) {
          mountAuthRoutes(server.polka, authAdapter.routes);
        }

        // Middleware: resolve every request to req.session
        server.polka.use(async (req: any, _res: any, next: any) => {
          // Skip for socket RPC calls — session already injected
          if (req._socketRpc) return next();
          try {
            req.session = await authAdapter!.resolveRequest(req);
          } catch {
            req.session = null;
          }
          next();
        });
      }

      // Middleware: propagate request user via AsyncLocalStorage so hooks
      // can access it regardless of whether the save originates from
      // auto-CRUD routes or custom controllers.
      //
      // We also create a per-request `RefLoader` here so every
      // `BackendAdapter.findById` call inside the request scope
      // coalesces concurrent ref-proxy resolutions into one
      // `WHERE id IN (...)` batch per type per microtask. Outside
      // this scope (background jobs, hooks fired from non-HTTP code
      // paths, tests) `findById` falls through to the direct
      // per-id query. See `services/ref-loader.ts` for the contract.
      server.polka.use((req: any, _res: any, next: any) => {
        const user = req.session?.user ?? null;
        const refLoader = new RefLoader((type, ids) =>
          adapter.batchFindByType(type, ids),
        );
        runWithRequestContext({ user, refLoader }, () => {
          next();
        });
      });

      if (config.middleware?.length) {
        for (const middleware of config.middleware) {
          server.polka.use(wrapHttpHandler(middleware));
        }
      }

      // Middleware: optional post-auth hook. Fires for every request
      // that has reached this point with a resolved session — covers
      // both HTTP (after the auth-resolve middleware above) and
      // socket-RPC (`req._socketRpc` skipped resolve but had session
      // pre-injected). Errors are swallowed so a faulty hook can never
      // break the request path.
      if (config.onAuthenticatedRequest) {
        const hook = config.onAuthenticatedRequest;
        server.polka.use((req: any, res: any, next: any) => {
          if (req.session?.user) {
            try {
              const result = hook(req, req.session ?? null, res);
              if (result instanceof Promise) {
                result.catch((err: unknown) => {
                  log.warn(`[onAuthenticatedRequest] async error: ${err}`);
                });
              }
            } catch (err) {
              log.warn(`[onAuthenticatedRequest] error: ${err}`);
            }
            // If the hook wrote a response synchronously (e.g. a step-up
            // gate calling `error(res, 403, ...)`), short-circuit. Async
            // writes can't reach this branch — telemetry stays
            // fire-and-forget.
            if (res.writableEnded) return;
          }
          next();
        });
      }

      // ── Step 11: Default routes ────────────────────────────────────
      server.polka.get(`/${version}/health`, (_req: any, res: any) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            uptime: process.uptime(),
            models: models.length,
            version,
          }),
        );
      });

      // ── Step 12: Register auto-CRUD routes ─────────────────────────
      // CRUD routes only make sense when this process serves HTTP. Worker-only
      // processes skip them so the `/health` endpoint is the lone exposed route.
      const crudCount = flags.server
        ? registerModelRoutes(models, adapter, version)
        : 0;
      log.info(
        flags.server
          ? `Registered ${crudCount} auto-CRUD route(s)`
          : `Skipped auto-CRUD route registration (RUN_SERVER=false)`,
      );

      // ── Step 13: Auto-discover ──────────────────────────────────────
      // Scan all configured directories. Files self-register by calling
      // route.*, hook.*, job(), cron() at import time. Doesn't matter
      // which dir a hook / job / cron lives in — just that the file
      // exists.
      //
      // We always import the files (so module-level side effects like
      // singleton construction fire identically across processes), but
      // we apply per-flag gates further down:
      //   - custom routes from `controllers/` only attach to polka when RUN_SERVER=true
      //   - hooks fire only when RUN_HOOKS=true (gated in BackendAdapter.runHooks)
      //   - BullMQ workers start only when RUN_JOBS != false (gated below)
      //   - cron schedulers start only when RUN_CRONS=true (gated below)
      const routesBefore = getRoutes().length;
      const hooksBefore = getHooks().length;
      const jobsBefore = getJobs().length;
      const cronsBefore = getCrons().length;

      const dirs = [
        config.controllers,
        config.hooks,
        config.jobs,
        config.crons,
      ].filter((d): d is string => typeof d === "string");
      // Shared across every scan in this app so a file pulled in via
      // a side-effect chain (e.g. `hooks/x.ts` imports `jobs/y.ts`)
      // isn't imported again when its own dir is scanned. Critical for
      // registry pushes (`job()`, `hook()`, `cron()`) since re-running
      // them creates duplicate entries.
      const importedFiles = new Set<string>();
      let totalFiles = 0;
      for (const dir of dirs) {
        totalFiles += await discoverAndImport(dir, "module", importedFiles);
      }

      const routesAfter = getRoutes().length;
      const hooksAfter = getHooks().length;
      const jobsAfter = getJobs().length;
      const cronsAfter = getCrons().length;

      log.info(
        `Discovered ${totalFiles} file(s) → ` +
          `${routesAfter - routesBefore} route(s), ` +
          `${hooksAfter - hooksBefore} hook(s), ` +
          `${jobsAfter - jobsBefore} job(s), ` +
          `${cronsAfter - cronsBefore} cron(s)`,
      );

      // ── Step 14: Apply discovered routes to Polka ──────────────────
      // Custom routes registered via `route.get/post/...` only attach when
      // RUN_SERVER=true. Worker-only processes intentionally leave them
      // unbound so they're unreachable on the worker URL.
      const routes = getRoutes();
      if (flags.server) {
        for (const entry of routes) {
          const method = entry.method.toLowerCase() as keyof typeof server.polka;
          if (typeof server.polka[method] === "function") {
            const handlers = [...entry.middlewares, entry.handler];
            (server.polka[method] as any)(entry.path, ...handlers);
          }
        }
      } else if (routes.length > 0) {
        log.info(
          `Skipped attaching ${routes.length} custom route(s) (RUN_SERVER=false)`,
        );
      }

      // ── Step 15: Start per-job-name BullMQ workers ─────────────────
      //
      // Each registered job gets its own BullMQ queue named
      // `${defaultName}:${jobName}`. Workers subscribe to specific queues:
      //
      //   - RUN_JOBS=true    → subscribe to every registered job's queue
      //   - RUN_JOBS=false   → don't subscribe to anything (enqueue still
      //                        works; the queues just sit waiting)
      //   - RUN_JOBS=a,b,c   → subscribe only to those job names. Useful
      //                        for splitting workloads across worker
      //                        fleets, or routing GPU-heavy jobs to a
      //                        dedicated cluster.
      //
      // Per-job concurrency comes from `job(name, handler, { concurrency })`
      // — each worker uses its own value, so total in-flight work is the
      // SUM of opted-in concurrencies (not the max, which was the
      // pre-change footgun).
      //
      // Hard cutover: no worker subscribes to the bare `defaultName` queue,
      // so any jobs left there by pre-routing versions of @parcae/backend
      // will be stranded. Operators upgrading across this boundary should
      // drain the legacy queue (`bullmq` CLI / `redis-cli DEL bull:<name>`)
      // before deploying.
      const registeredJobs = getJobs();
      const wantsAnyJobs = flags.jobs !== false;

      // Eagerly create the BullMQ queue for every registered job, even on
      // processes that won't run a worker. This guarantees:
      //   - the queue meta key exists in Redis with our standard defaults
      //     (3 attempts, exponential backoff, retention windows)
      //   - third-party consumers can subscribe immediately without
      //     waiting for the first enqueue to spawn the queue lazily
      //   - monitoring tools (Bull Board, Arena) see every known queue
      // The bare `defaultName` queue stays uncreated by design — nothing
      // routes there after the per-name cutover.
      if (queue.get() && registeredJobs.length > 0) {
        for (const jobEntry of registeredJobs) {
          queue.get(queue.queueNameFor(jobEntry.name));
        }
      }

      if (wantsAnyJobs && registeredJobs.length > 0 && queue.get()) {
        // Capture into a local so TS can narrow inside the closure below.
        const jobsFlag = flags.jobs;

        const shouldHandle = (jobName: string): boolean => {
          if (jobsFlag === true) return true;
          if (jobsFlag instanceof Set) return jobsFlag.has(jobName);
          return false;
        };

        // Validate the name list against the registered jobs so operators
        // catch typos at startup instead of wondering why a job never runs.
        if (jobsFlag instanceof Set) {
          const unknown = [...jobsFlag].filter(
            (name) => !registeredJobs.some((j) => j.name === name),
          );
          if (unknown.length > 0) {
            log.warn(
              `[jobs] RUN_JOBS references unknown job name(s): ${unknown.join(", ")} — ` +
                `nothing will pick them up from this process.`,
            );
          }
        }

        const started: Array<{ name: string; concurrency: number }> = [];
        const skipped: string[] = [];

        for (const jobEntry of registeredJobs) {
          if (!shouldHandle(jobEntry.name)) {
            skipped.push(jobEntry.name);
            continue;
          }
          const concurrency = jobEntry.options?.concurrency ?? 1;
          const queueName = queue.queueNameFor(jobEntry.name);
          queue.createWorker(
            queueName,
            async (bullJob) => {
              return jobEntry.handler({
                data: bullJob.data,
                bullJob,
                attempt: bullJob.attemptsMade,
              });
            },
            concurrency,
          );
          started.push({ name: jobEntry.name, concurrency });
        }

        if (started.length > 0) {
          const total = started.reduce((s, j) => s + j.concurrency, 0);
          log.info(
            `Started ${started.length} BullMQ worker(s) — total concurrency ${total} ` +
              `(${started.map((j) => `${j.name}=${j.concurrency}`).join(", ")})`,
          );
        }
        if (skipped.length > 0) {
          log.info(
            `Skipped ${skipped.length} job(s) not selected by RUN_JOBS: ${skipped.join(", ")}`,
          );
        }
      } else if (!wantsAnyJobs && registeredJobs.length > 0) {
        log.info(
          `Skipped starting BullMQ workers (RUN_JOBS=false) — ` +
            `${registeredJobs.length} job(s) discovered but unhandled by this process`,
        );
      }

      // ── Step 15.5: Schedule local crons ────────────────────────────
      // Crons are NOT BullMQ jobs — they're in-process scheduled tasks
      // backed by croner. They fire wherever RUN_CRONS is enabled;
      // cross-process dedup happens inside the handler via a Redis
      // try-lock keyed on the cron name + fire timestamp.
      //
      //   - RUN_CRONS=true       → schedule every registered cron
      //   - RUN_CRONS=false      → don't schedule anything
      //   - RUN_CRONS=a,b,c      → schedule only those names (pins
      //                            specific schedules to specific fleets)
      //
      // Multi-process safety is automatic: every contender attempts
      // `tryLock("cron:tick:<name>:<fireMs>", ttl)`. Exactly one wins via
      // Redis SET NX EX semantics, the rest skip silently.
      const registeredCrons = getCrons();
      const wantsAnyCrons = flags.crons !== false;

      if (wantsAnyCrons && registeredCrons.length > 0) {
        const cronsFlag = flags.crons;
        const shouldSchedule = (cronName: string): boolean => {
          if (cronsFlag === true) return true;
          if (cronsFlag instanceof Set) return cronsFlag.has(cronName);
          return false;
        };

        if (cronsFlag instanceof Set) {
          const unknown = [...cronsFlag].filter(
            (name) => !registeredCrons.some((c) => c.name === name),
          );
          if (unknown.length > 0) {
            log.warn(
              `[crons] RUN_CRONS references unknown cron name(s): ` +
                `${unknown.join(", ")} — nothing will fire them from this process.`,
            );
          }
        }

        const startedCrons: Cron[] = [];
        resources.crons = startedCrons;
        const scheduled: string[] = [];
        const skipped: string[] = [];
        for (const entry of registeredCrons) {
          if (!shouldSchedule(entry.name)) {
            skipped.push(entry.name);
            continue;
          }
          startedCrons.push(startCron(entry, pubsub));
          scheduled.push(`${entry.name}@"${entry.pattern}"`);
        }
        if (scheduled.length > 0) {
          log.info(`Scheduled ${scheduled.length} cron(s): ${scheduled.join(", ")}`);
        }
        if (skipped.length > 0) {
          log.info(
            `Skipped ${skipped.length} cron(s) not selected by RUN_CRONS: ${skipped.join(", ")}`,
          );
        }
      } else if (!wantsAnyCrons && registeredCrons.length > 0) {
        log.info(
          `Skipped scheduling ${registeredCrons.length} cron(s) (RUN_CRONS=false)`,
        );
      }

      // ── Step 16: Socket.IO connection handling ─────────────────────
      // Only attach socket handlers when RUN_SERVER=true. The Socket.IO
      // server itself is always constructed (the createServer_ contract
      // expects it), but on worker-only processes it sits idle — no
      // clients should be hitting the worker URL anyway.
      if (flags.server) server.io.on("connection", (socket) => {
        const socketSession = createSocketSessionController(
          socket.id,
          authAdapter,
          subscriptions,
        );

        // ── RPC: pipe socket calls through Polka's HTTP handler ─────
        socket.on(
          "call",
          async (
            requestId: string,
            method: string,
            path: string,
            data: any,
          ) => {
            try {
              // Parse query string from path
              const [pathname, qs] = path.split("?");
              const query: Record<string, any> = {};
              if (qs) {
                for (const pair of qs.split("&")) {
                  const [k, v] = pair.split("=");
                  if (k)
                    query[decodeURIComponent(k)] = v
                      ? decodeURIComponent(v)
                      : "";
                }
              }

              // Merge URL query params with socket data for GET requests
              const mergedQuery =
                method.toUpperCase() === "GET" ? { ...query, ...data } : query;

              // Build fake req that Polka's handler can process.
              // NOTE: Polka's handler unconditionally overwrites req.query
              // with querystring.parse(info.query), which destroys complex
              // objects (like __query arrays). We stash the real query in
              // _socketQuery so middleware can restore it.
              const fakeReq: any = {
                method: method.toUpperCase(),
                url: path,
                headers: {
                  ...socket.handshake.headers,
                  "content-type": "application/json",
                },
                body: data,
                query: mergedQuery,
                _socketQuery: mergedQuery,
                params: {},
                session: socketSession.session,
                _socketRpc: true, // marker: skip auth middleware resolution
                _socketId: socket.id,
                _parsedUrl: { pathname, query: qs || "", _raw: path },
              };

              // Build fake res that captures the response. See
              // `socket-fake-res.ts` for the full contract — short
              // version: a step-up gate that writes 403 to res via
              // `error(res, 403, …)` sets `writableEnded`, which the
              // `onAuthenticatedRequest` polka middleware checks to
              // short-circuit. `writeHead`/`end` are idempotent so a
              // late write from a downstream handler can't clobber the
              // first response.
              const fakeRes = createSocketFakeRes(socket, requestId);

              // Run through Polka's full handler (includes middleware, auth, auto-CRUD, custom routes)
              (server!.polka as any).handler(fakeReq, fakeRes);
            } catch (err: any) {
              log.error(`[socket] RPC error:`, err);
              const compressed = pako.gzip(
                JSON.stringify(
                  compress({
                    result: null,
                    success: false,
                    status: err instanceof ClientError ? err.status : 500,
                    error:
                      err instanceof ClientError
                        ? err.message
                        : "An error occurred while processing your request",
                  }),
                ),
              );
              socket.emit(requestId, compressed);
            }
          },
        );

        // ── Hello / resync — session + reconnect protocol ─────────
        //
        // `hello` runs once per (re)connection: client sends its
        // bearer token, server resolves the session, and binds it to
        // this socket. The transport invokes this exactly once per
        // socket; reconnects get a fresh `hello` automatically.
        //
        // `resync` is the batched reconnect refetch. The client hands
        // us its live cache entries; we re-evaluate each query
        // against the DB and re-bind subscriptions on the new socket
        // id. One round trip restores N queries.
        socket.on(
          "hello",
          (payload: { token?: string | null }, callback: any) =>
            socketSession.hello(payload, callback),
        );

        socket.on(
          "resync",
          async (
            payload: {
              queries?: Array<{
                key: string;
                modelType: string;
                steps: unknown[];
                queryHash?: string | null;
                /**
                 * `false` when the client mounted the matching
                 * `useQuery` with `{ subscribe: false }`. Forwarded
                 * to `resyncQueries`, which takes the
                 * `runQueryStatic` path for these entries.
                 */
                subscribe?: boolean;
              }>;
            },
            callback: any,
          ) => {
            const entries = Array.isArray(payload?.queries) ? payload.queries : [];
            if (entries.length === 0) {
              callback?.({ success: true, results: [] });
              return;
            }
            try {
              const results = await resyncQueries(
                socket.id,
                socketSession.session,
                entries,
                adapter,
                {
                  maxEntries: maxResyncQueries,
                  concurrency: resyncConcurrency,
                },
              );
              callback?.({ success: true, results });
            } catch (err: any) {
              log.error("[socket] resync failed:", err);
              callback?.({
                success: false,
                error:
                  err instanceof ClientError
                    ? err.message
                    : "Resync failed",
              });
            }
          },
        );

        // ── route.on() — custom Socket.IO event handlers ──────────
        const socketHandlers = getSocketHandlers();
        for (const entry of socketHandlers) {
          socket.on(entry.event, async (data: any) => {
            const ctx: SocketContext = {
              socket,
              io: server!.io,
              data,
              session: socketSession.session,
              socketId: socket.id,
              emit: (event: string, ...args: any[]) =>
                socket.emit(event, ...args),
            };
            try {
              await runSocketChain(entry.middlewares, entry.handler, ctx);
            } catch (err: any) {
              log.error(`[socket] ${entry.event} error:`, err);
              socket.emit("error", {
                event: entry.event,
                status: err instanceof ClientError ? err.status : 500,
                message:
                  err instanceof ClientError
                    ? err.message
                    : "An error occurred",
              });
            }
          });
        }

        // Query subscriptions
        socket.on("unsubscribe:query", (hash: string) => {
          subscriptions.unsubscribe(socket.id, hash);
        });

        socket.on("disconnect", () => {
          subscriptions.unsubscribeAll(socket.id);
        });
      });

      // ── Step 17: Start listening ───────────────────────────────────
      // ALWAYS bind to PORT, even on worker-only processes (RUN_SERVER=false).
      // Cloud Run / k8s health probes need *something* to talk to, and the
      // `/{version}/health` endpoint registered in Step 11 is the cheapest
      // signal of liveness we have.
      await listenServer(server.httpServer, port);

      const exposedRoutes = flags.server ? routes.length + crudCount : 0;
      log.success(
        `Ready on port ${port} — ` +
          `${models.length} models, ` +
          `${exposedRoutes} routes` +
          (flags.server ? "" : " (health only — RUN_SERVER=false)") +
          `, ${getHooks().length} hooks, ` +
          `${getJobs().length} jobs, ` +
          `${getCrons().length} crons`,
      );
          state = "started";
        } catch (err) {
          await shutdownResources(resources);
          clearApplicationContext();
          server = null;
          teardown = null;
          state = "failed";
          throw err;
        }
      });
    },

    async stop() {
      return serialize(async () => {
        if (state === "idle" || state === "stopped" || state === "failed") {
          return;
        }
        state = "stopping";
        log.info("Shutting down...");
        await shutdownResources(teardown ?? {});
        clearApplicationContext();
        server = null;
        teardown = null;
        state = "stopped";
        log.info("Shutdown complete");
      });
    },
  };
}
