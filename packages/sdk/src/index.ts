/**
 * @parcae/sdk
 *
 * Client SDK for Parcae backends.
 * Pluggable transport: Socket.IO (default), SSE, or custom.
 */

export { createClient } from "./client";
export type { ClientConfig, ParcaeClient } from "./client";

// Transports
export { SocketTransport } from "./transports/socket";
export type { SocketTransportConfig } from "./transports/socket";
export { SSETransport } from "./transports/sse";
export type { SSETransportConfig } from "./transports/sse";

// Re-export model + transport types for convenience
export { Model, FrontendAdapter } from "@parcae/model";
export type { Transport } from "@parcae/model";
