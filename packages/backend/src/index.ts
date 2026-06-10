/**
 * @parcae/backend
 *
 * TypeScript backend framework with auto-CRUD, realtime subscriptions,
 * and background jobs. Built on Polka, Socket.IO, Knex, and BullMQ.
 */

// App
export { createApp } from "./app";
export type { ParcaeApp, AppConfig } from "./app";

// Config
export {
  parseConfig,
  configSchema,
  isSqliteUrl,
  sqliteFilename,
  resolveRuntimeFlags,
} from "./config";
export type { Config, RuntimeFlags } from "./config";

// Server
export { createServer_ } from "./server";

// Adapters
export { BackendAdapter } from "./adapters/model";
export type { BackendServices } from "./adapters/model";
export { registerModelRoutes } from "./adapters/routes";

// Services
export { PubSub } from "./services/pubsub";
export type { PubSubConfig } from "./services/pubsub";
export { QueueService, addJobIfNotExists } from "./services/queue";
export type { QueueConfig } from "./services/queue";
export { QuerySubscriptionManager } from "./services/subscriptions";
export type { QueryEmitEnvelope } from "./services/subscriptions";
export { ChangeBus } from "./services/changeBus";
export type {
  Change,
  ChangeOp,
  ChangeSource,
  ChangeListener,
} from "./services/changeBus";
export {
  ListenNotifyPoller,
  PARCAE_CHANNEL,
} from "./services/listenNotifyPoller";
export {
  ensureChangeTriggers,
  triggerFunctionSql,
  createTriggerSql,
  TRIGGER_FUNCTION_NAME,
} from "./services/changeTriggers";
export {
  withTransaction,
  getActiveTransactionFrame,
} from "./services/transactionContext";
export type {
  TransactionFrame,
  WithTransactionDeps,
} from "./services/transactionContext";
export {
  enqueue,
  lock,
  getQueue,
  getPubSub,
  getChangeBus,
  getIo,
  getRuntimeFlags,
  runWithRequestContext,
  getRequestUser,
} from "./services/context";
export type { EnqueueOptions } from "./services/context";

// Auth (adapter interface — implementations in @parcae/auth-betterauth, @parcae/auth-clerk)
export type { AuthAdapter, AuthSession, AuthSetupContext } from "./auth";

// Schema
export { SchemaResolver } from "./schema/resolver";
export { generateSchemas, loadCachedSchemas } from "./schema/generate";

// Routing
export {
  route,
  Controller,
  getRoutes,
  clearRoutes,
  getSocketHandlers,
  clearSocketHandlers,
  runSocketChain,
  requireSocketAuth,
} from "./routing/route";
export type {
  RouteHandler,
  Middleware,
  RouteOptions,
  RouteEntry,
  SocketContext,
  SocketHandler,
  SocketMiddleware,
  SocketEntry,
} from "./routing/route";

export { hook, getHooks, getHooksFor, clearHooks } from "./routing/hook";
export type {
  HookTiming,
  HookAction,
  HookHandler,
  HookContext,
  HookOptions,
  HookEntry,
} from "./routing/hook";

export { job, getJobs, getJob, clearJobs } from "./routing/job";
export type {
  JobHandler,
  JobContext,
  JobOptions,
  JobEntry,
} from "./routing/job";

export { cron, getCrons, getCron, clearCrons } from "./routing/cron";
export type {
  CronHandler,
  CronContext,
  CronOptions,
  CronEntry,
} from "./routing/cron";

export {
  migration,
  getMigrations,
  clearMigrations,
} from "./routing/migration";
export type {
  Engine,
  MigrationContext,
  MigrationHandler,
  MigrationOptions,
  MigrationEntry,
} from "./routing/migration";

export {
  runMigrations,
  ParcaeMigrationSource,
  MIGRATIONS_TABLE,
} from "./adapters/migrations";
export type {
  RunMigrationsOptions,
  RunMigrationsResult,
} from "./adapters/migrations";

export {
  discoverMigrations,
  listMigrationFiles,
} from "./adapters/migration-discovery";

export {
  META_TABLE,
  MigrationChecksumError,
  buildListing,
  classifyStatement,
  effectFromMeta,
  effectLabel,
  ensureMetaTable,
  extractRowCount,
  readMetaRows,
  sha256File,
  verifyChecksums,
  writeMetaRow,
} from "./adapters/migration-meta";
export type {
  MigrationEffect,
  MigrationListing,
  MigrationMetaRow,
  MigrationState,
  StatementKind,
} from "./adapters/migration-meta";

export { detectEngine } from "./adapters/engine";

// Search
export { searchAll } from "./search";
export type { SearchResult, SearchAllOptions } from "./search";

// Response helpers
export {
  json,
  ok,
  error,
  unauthorized,
  forbidden,
  notFound,
  badRequest,
  ClientError,
} from "./helpers";

// Logger
export { log } from "./logger";

// Re-export model for convenience
export { Model } from "@parcae/model";
