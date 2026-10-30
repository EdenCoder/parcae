/**
 * Pages over one engine, as the phone runs them: each page is a fresh copy of this package and of
 * @parcae/model, sharing one `globalThis`, one client and one server.
 */

import { vi, type Mock } from "vitest";

import type { RowStorage } from "../rows";
import type { LiveQueryStore } from "../live-query";

export type Data = Record<string, unknown>;
type Step = { method: string; args: unknown[] };
type Entry = { key: string; modelType: string; steps: Step[]; subscribe?: boolean; have?: Record<string, string> };
type Handler = (...args: any[]) => void;

/** The server: each type's rows, sent as a read selects them, under one hash per read. */
export function server(tables: Record<string, Data[]>) {
  const answer = (entry: Entry) => {
    const select = entry.steps.filter((step) => step.method === "select").flatMap((step) => step.args.flat() as string[]);
    const picked = (row: Data) =>
      select.length
        ? Object.fromEntries(Object.entries(row).filter(([key]) => ["id", ...select].includes(key.replace(/^\$/, ""))))
        : { ...row };
    const items = (tables[entry.modelType] ?? []).map(picked);
    const hash = entry.subscribe === false ? null : `H${entry.key.length}:${entry.key.slice(-12)}`;
    return {
      key: entry.key,
      hash,
      totalCount: items.length,
      ...(entry.have ? { ids: items.map((row) => row.id as string), items } : { items }),
    };
  };
  return { tables, answer };
}

/** One client for every page: its socket events, query pushes and session are the test's to drive. */
export function client(serve: ReturnType<typeof server>, transport: Record<string, unknown> = {}) {
  const events = new Map<string, Set<Handler>>();
  const queries = new Map<string, Set<Handler>>();
  const session = new Set<() => void>();
  const diagnostics: Array<[string, unknown]> = [];
  let adapter: any;
  const fake = {
    session    : { state: { status: "authenticated", userId: "u1" as string | null, version: 1 }, subscribe: (fn: () => void) => (session.add(fn), () => session.delete(fn)) },
    connection : { state: { status: "connected", lastError: null } },
    isConnected: true,
    resync     : vi.fn(async (entries: Entry[]) => entries.map(serve.answer)) as Mock<(entries: Entry[]) => Promise<unknown[]>>,
    withQuerySubscriptions: <T>(run: () => Promise<T>) => run(),
    get adapter() {
      return adapter;
    },
    bind       : (model: any) => model.bind(adapter),
    subscribe(event: string, handler: Handler) {
      const set = queries.get(event) ?? new Set();
      set.add(handler);
      queries.set(event, set);
      return () => set.delete(handler);
    },
    on(event: string, handler: Handler) {
      const set = events.get(event) ?? new Set();
      set.add(handler);
      events.set(event, set);
    },
    off(event: string, handler: Handler) {
      events.get(event)?.delete(handler);
    },
    refreshSession   : async () => ({ userId: fake.session.state.userId }),
    terminateSession : async () => {},
    _emitDiagnostic  : (event: string, payload: unknown) => void diagnostics.push([event, payload]),
    // The test's levers.
    diagnostics,
    emit(event: string, ...args: unknown[]) {
      for (const handler of events.get(event) ?? []) handler(...args);
    },
    push(hash: string, payload: unknown) {
      for (const handler of queries.get(`query:${hash}`) ?? []) handler(payload);
    },
    listeners: (event: string) => events.get(event)?.size ?? 0,
    pushed   : () => [...queries].filter(([, set]) => set.size > 0).map(([event]) => event.slice(6)),
    settle(status: string, userId: string | null) {
      fake.session.state = { ...fake.session.state, status, userId };
      for (const fn of session) fn();
    },
    useAdapter(FrontendAdapter: new (t: any) => unknown) {
      adapter ??= new FrontendAdapter(transport);
    },
  };
  return fake;
}

/** A show as a page's own copy of @parcae/model makes it. */
export interface Show {
  id: string;
  title: string;
  premise?: string;
}

/** A page as the test drives it. */
export interface TestPage {
  lynx    : any;
  Show    : any;
  shows   : (steps?: Step[], options?: object) => LiveQueryStore<Show>;
  destroy : () => void;
}

/** A page: its own copy of the package and of @parcae/model, joined to the engine at once. */
export async function page(line: ReturnType<typeof client>, storage: RowStorage | null = null): Promise<TestPage> {
  vi.resetModules();
  const model = await import("@parcae/model");
  const lynx = { ...(await import("../engine")), ...(await import("../page")), ...(await import("../live-query")), ...(await import("../writes")) };
  line.useAdapter(model.FrontendAdapter);
  const tt: { callDestroyLifetimeFun?: () => void } = {};
  Object.assign(globalThis, { lynxCoreInject: { tt } });
  lynx.provideEngine({
    client  : () => line as never,
    auth    : { init() {}, getToken: async () => null, onChange: () => () => {} },
    storage,
  });
  lynx.page();
  class PageShow extends model.Model {
    static type = "show" as const;
    title = "";
    declare premise?: string;
  }
  /** A live read of shows. */
  const shows = (steps: Step[] = [], options = {}) =>
    lynx.createLiveQuery(() => {
      let chain: any = line.adapter.query(line.bind(PageShow));
      for (const { method, args } of steps) chain = chain[method](...args);
      return chain;
    }, options);
  return { lynx, Show: PageShow, shows: shows as TestPage["shows"], destroy: () => tt.callDestroyLifetimeFun?.() };
}

/** A fresh `globalThis`: no engine, no card. */
export function reset(): void {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("parcae:lynx:engine")];
  Object.assign(globalThis, { lynx: { reportError: (error: Error) => { throw error; } } });
}

export function retain(store: { retain(fn: () => void): () => void }) {
  let changes = 0;
  const release = store.retain(() => changes++);
  return { changes: () => changes, release };
}
