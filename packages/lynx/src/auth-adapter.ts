/// <reference types="@lynx-js/types" />

/**
 * AuthClientAdapter factory for Lynx apps.
 *
 * Token custody stays with the app (a native store, secure storage,
 * whatever the platform provides) — the adapter only needs an async
 * getter and a GlobalEventEmitter event announcing changes. The app
 * emits that event however fits its architecture: natively on
 * activity resume for cross-bundle sign-ins, locally from a sign-out
 * handler, etc. `startLifecycle` turns those signals into
 * refreshSession / terminateSession calls.
 */

import type { AuthClientAdapter } from "@parcae/sdk";

export interface EmitterAuthAdapterOptions {
  /** Resolve the current bearer token. `null` = anonymous. */
  getToken(): Promise<string | null>;
  /** GlobalEventEmitter event announcing token changes. Default `auth.changed`. */
  event?: string;
}

export function createEmitterAuthAdapter(
  options: EmitterAuthAdapterOptions,
): AuthClientAdapter {
  const event = options.event ?? "auth.changed";
  return {
    init() {
      // Base URL binding is the app facade's concern.
    },
    getToken() {
      "background only";
      return options.getToken();
    },
    onChange(callback) {
      "background only";
      const handler = () => {
        "background only";
        options.getToken().then(callback, () => callback(null));
      };
      const emitter = lynx.getJSModule("GlobalEventEmitter");
      emitter.addListener(event, handler);
      return () => emitter.removeListener(event, handler);
    },
  };
}
