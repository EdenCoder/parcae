/**
 * The app's one sync engine, on `globalThis`, made by the first card that joins: the host, which
 * must outlive every other card, so the engine and the socket it dialled last the app's life.
 * Holds no page's objects: what reaches a page is plain data and the page's own callbacks.
 *
 * Pages in one JavaScript engine still run their own copy of every module, so the engine's code is
 * the host's copy, on the host's timers and the host's bridge to the phone.
 */

import type { AuthClientAdapter, ParcaeClient, SessionStatus } from "@parcae/sdk";

import type { Page } from "./page";
import type { RowStorage } from "./rows";
import { startQueue, keepWrite, sendWrites, readWaiting, waitingWrites, type WriteOutcome } from "./queue";
import { guarded, lostReads, startReads, retainRead, refetchRead, resyncReads, resetReads } from "./reads";

/** What the app gives the engine at module scope; the first card to join makes the engine from its own. */
export interface EngineConfig {
  /** Makes the app's one client; it lives as long as the engine. */
  client  : () => ParcaeClient;
  auth    : AuthClientAdapter;
  storage : RowStorage | null;
}

/** What the engine tells a page besides its reads. */
export interface PageHooks {
  /** The session settled on another account, or none: the page's records go. */
  reset(): void;
  /** The waiting changes moved; `outcome` is the server's word on one, null when one was kept. */
  moved(outcome: WriteOutcome | null): void;
}

/** A page as the engine holds it: let go of whole when its card is destroyed. */
export interface Joined extends Page {
  drop(): void;
}

const ENGINE = Symbol.for("parcae:lynx:engine");

let config: EngineConfig | null = null;

/** Stores the config; makes nothing, so it is safe on both threads. */
export function provideEngine(next: EngineConfig): void {
  config = next;
}

/** @internal Joins a card; the engine is made, from this copy's config, if none exists. */
export function join(hooks: PageHooks): Joined {
  "background only";
  const host = globalThis as { [ENGINE]?: (hooks: PageHooks) => Joined };
  if (!config) throw new Error("@parcae/lynx: call provideEngine(...) before page()");
  host[ENGINE] ??= makeEngine(config);
  return host[ENGINE](hooks);
}

function makeEngine({ client: makeClient, auth, storage }: EngineConfig): (hooks: PageHooks) => Joined {
  const client = makeClient();
  const pages = new Set<PageHooks>();
  const each = (call: (hooks: PageHooks) => void) => {
    for (const hooks of pages) guarded(() => call(hooks));
  };
  startReads(client, storage);
  startQueue(client, storage, (outcome) => each((hooks) => hooks.moved(outcome)));

  // A new token is a fresh hello on the live socket; sign-out ends the session. Only a signed-in
  // session can be signed out of: ending an anonymous or pending one is sticky.
  auth.onChange((token) => {
    if (token !== null) client.refreshSession().catch(() => {});
    else if (client.session.state.status === "authenticated") client.terminateSession().catch(() => {});
  });

  // A settled identity, or one settling, invalidates every page's rows: they were read as someone
  // else. The hello that settles it also asks for a resync, which the reset already covers.
  let status: SessionStatus | null = null;
  let userId: string | null | undefined;
  let resetThisTurn = false;
  const settle = () => {
    const state = client.session.state;
    if (state.status === status && state.userId === userId) return;
    ({ status, userId } = state);
    const ready = status === "anonymous" || status === "authenticated";
    each((hooks) => hooks.reset());
    resetReads(ready, userId ?? null);
    readWaiting();
    if (!ready) return;
    resetThisTurn = true;
    queueMicrotask(() => {
      resetThisTurn = false;
    });
  };
  client.session.subscribe(settle);
  settle();

  // The server's subscriptions died with the old socket: every retained read asks again at once.
  client.on("resync-required", () => {
    sendWrites();
    if (resetThisTurn) resetThisTurn = false;
    else if (status === "anonymous" || status === "authenticated") resyncReads();
  });
  client.on("disconnected", lostReads);
  client.on("error", lostReads);

  return (hooks) => {
    pages.add(hooks);
    const releases = new Set<() => void>();
    const held = (release: () => void) => {
      releases.add(release);
      return () => {
        if (releases.delete(release)) release();
      };
    };
    return {
      client,
      on(event, handler) {
        const heard = (...args: any[]) => guarded(() => handler(...args));
        client.on(event, heard);
        return held(() => client.off(event, heard));
      },
      retain : (request, view) => held(retainRead(request, view)),
      refetch: refetchRead,
      keep   : keepWrite,
      waiting: waitingWrites,
      drop() {
        pages.delete(hooks);
        for (const release of releases) release();
        releases.clear();
      },
    };
  };
}
