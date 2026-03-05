/**
 * @parcae/backend
 *
 * TypeScript backend framework with auto-CRUD, realtime subscriptions,
 * and background jobs. Built on Polka, Socket.IO, Knex, and BullMQ.
 */

export { createApp } from "./app";
export type { ParcaeApp, AppConfig } from "./app";

export { SchemaResolver, resolveFallbackSchema } from "./schema/resolver";
export { generateSchemas, loadCachedSchemas } from "./schema/generate";

// Re-export model for convenience
export { Model } from "@parcae/model";
