/**
 * Late-bound client access. Lynx apps create their ParcaeClient inside
 * a `'background only'` function (socket.io can't compile on the main
 * Lepus thread), so this package can't import a client instance at
 * module scope — the app registers a getter instead, either directly
 * via `provideClient` at module scope (storing the reference is safe
 * on both threads) or implicitly through `startLifecycle`.
 */

import type { ParcaeClient } from "@parcae/sdk";

let getter: (() => ParcaeClient) | null = null;

export function provideClient(getClient: () => ParcaeClient): void {
  getter = getClient;
}

export function requireClient(): ParcaeClient {
  "background only";
  if (!getter) {
    throw new Error(
      "@parcae/lynx: no client provided — call provideClient(getClient) or startLifecycle(...) before using live queries",
    );
  }
  return getter();
}
