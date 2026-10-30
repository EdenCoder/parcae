/**
 * This card's hold on the engine. Lynx destroying the card lets go of everything the page holds,
 * whether its tree unmounted or crashed.
 */

import type { ParcaeClient, SessionMachine, ConnectionMachine } from "@parcae/sdk";

import { join } from "./engine";
import { moved } from "./writes";
import { resetStores } from "./live-query";
import type { StoredWrite } from "./rows";
import type { ReadView, ReadRequest } from "./reads";

/** The client as a page holds it: requests and state. Its events reach a page only through `Page.on`. */
export type PageClient = Omit<
  ParcaeClient,
  "on" | "off" | "send" | "dispose" | "subscribe" | "transport" | "unsubscribe" | "connection" | "session"
> & {
  connection : Pick<ConnectionMachine, "state">;
  session    : Pick<SessionMachine, "state">;
};

export interface Page {
  readonly client: PageClient;
  /** Hears the client's `event` until released or the card is destroyed. */
  on(event: string, handler: (...args: any[]) => void): () => void;
  /** @internal */ retain(request: ReadRequest, view: ReadView): () => void;
  /** @internal Asks the server again; only rows that moved come back. */ refetch(key: string): void;
  /** @internal Resolves once the change can't be lost: stored, or with no storage, answered. */ keep(write: StoredWrite): Promise<void>;
  /** @internal The account's waiting changes, oldest first. */ waiting(): readonly StoredWrite[];
}

/** The card's own Lynx core binding; ReactLynx set its destroy hook at load, before any page code. */
declare const lynxCoreInject: { tt: { callDestroyLifetimeFun?: () => void } };

let joined: Page | null = null;

/** This card's page, joined on first call. */
export function page(): Page {
  "background only";
  if (joined) return joined;
  const engine = join({ reset: resetStores, moved });
  const { tt } = lynxCoreInject;
  const destroy = tt.callDestroyLifetimeFun;
  tt.callDestroyLifetimeFun = () => {
    engine.drop();
    destroy?.call(tt);
  };
  joined = engine;
  // The engine tells a page only of later moves; what already waits it reads as it joins.
  moved(null);
  return joined;
}
