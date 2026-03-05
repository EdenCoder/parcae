/**
 * @parcae/backend
 *
 * TypeScript backend framework with auto-CRUD, realtime subscriptions,
 * and background jobs. Built on Polka, Socket.IO, Knex, and BullMQ.
 */

export { createApp } from "./app";
export type { ParcaeApp, AppConfig } from "./app";

// Re-export model for convenience
export { Model } from "@parcae/model";
