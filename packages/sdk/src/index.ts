export { createClient } from "./client";
export type { ClientConfig, ParcaeClient } from "./client";

export { AuthGate } from "./auth-gate";
export type { AuthStatus, AuthState } from "./auth-gate";

export { SocketTransport } from "./transports/socket";
export type { SocketTransportConfig } from "./transports/socket";
export { SSETransport } from "./transports/sse";
export type { SSETransportConfig } from "./transports/sse";

export { Model, FrontendAdapter } from "@parcae/model";
export type { Transport } from "@parcae/model";
