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

type TokenChangeCallback = (token: string | null) => void;

export interface EmitterAuthAdapterOptions {
  /** Resolve the current bearer token. `null` = anonymous. */
  getToken(): Promise<string | null>;
  /** GlobalEventEmitter event announcing token changes. Default `auth.changed`. */
  event?: string;
  /** Retries after a transient token-read failure. Default one retry. */
  retryAttempts?: number;
  /** Delay between token-read attempts in milliseconds. Default 250. */
  retryDelay?: number;
}

export function createEmitterAuthAdapter(
  options: EmitterAuthAdapterOptions,
): AuthClientAdapter {
  const event = options.event ?? "auth.changed";
  const retryAttempts = Math.max(0, options.retryAttempts ?? 1);
  const retryDelay = Math.max(0, options.retryDelay ?? 250);
  function onChange(callback: TokenChangeCallback) {
    "background only";
    let generation = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      "background only";
      const readGeneration = ++generation;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      const read = (attempt: number) => {
        options.getToken().then(
          (token) => {
            if (readGeneration === generation) callback(token);
          },
          () => {
            if (readGeneration !== generation || attempt >= retryAttempts) {
              return;
            }
            retryTimer = setTimeout(() => {
              retryTimer = null;
              read(attempt + 1);
            }, retryDelay);
          },
        );
      };
      read(0);
    };
    const emitter = lynx.getJSModule("GlobalEventEmitter");
    emitter.addListener(event, handler);
    return () => {
      generation++;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      emitter.removeListener(event, handler);
    };
  }

  return {
    init() {
      // Base URL binding is the app facade's concern.
    },
    getToken() {
      "background only";
      return options.getToken();
    },
    onChange,
  };
}
