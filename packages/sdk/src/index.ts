/**
 * @parcae/sdk
 *
 * Client SDK for Parcae backends.
 * Socket.IO transport with compression, auth, and request deduplication.
 */

export { createClient } from "./client.js";
export type { ClientConfig, ParcaeClient } from "./client.js";

// Re-export model for convenience
export { Model } from "@parcae/model";
