/**
 * A page's view of the engine's reads.
 *
 * ReactLynx executes component render code on the main (Lepus) thread for first paint, where the
 * engine doesn't exist (`'background only'`). Snapshot reads never touch it, so a main-thread
 * render pass just sees the store's initial state.
 *
 * A store hydrates its read's rows into the page's records, one object per record (rows.ts), and
 * lays the page's waiting changes over them (writes.ts). Every store in a bundle that names the
 * same read shares it, and so does every page: the engine counts them.
 *
 * This file is framework-agnostic (no Lynx / React imports) so the reconciliation core can be
 * unit-tested in node. The ReactLynx hook lives in `use-live-query.ts`.
 */

import { Model, SYM_SERVER_MERGE, serializeLazyQueryArgs, type QueryChain } from "@parcae/model";

import { page } from "./page";
import { layOver, waitingRemoves, waitingCreates } from "./writes";
import type { Read, ReadView, ReadRequest } from "./reads";
import { hold, fieldsOf, mergeRow, recordFor, forgetRecords, type Holder, type ServerRow } from "./rows";

export type LiveStatus = "loading" | "ready" | "error";

/**
 * `status` turns `ready` only on a server answer; rows drawn from storage come with `loading`.
 * `total` is the last answer's count, stored or the server's. Draw what a snapshot holds, and open
 * a page from a drawn row; act or count only on `ready`.
 */
export interface LiveSnapshot<T> {
  items: T[];
  status: LiveStatus;
  error: Error | null;
  total: number;
  /** Times the read was brought current, once more when a store retains a read the engine kept live; another read's answer redraws without one. */
  answers: number;
  /** `items` are an answer, the server's or a stored one, an empty answer too; until then the read holds nothing yet. */
  drawn: boolean;
}

interface HydratingClass<T> {
  hydrate(adapter: unknown, data: Record<string, unknown>): T;
}

export interface LiveRow {
  id?: string;
  tmp?: string;
  __data?: Record<string, unknown>;
  [SYM_SERVER_MERGE]?: (data: Record<string, unknown>) => unknown;
}

export interface LiveQueryStore<T> {
  snapshot(): LiveSnapshot<T>;
  /** Subscribe + refcount. The first retainer holds the engine's read, which draws what it has and asks for the rest. */
  retain(onChange: () => void): () => void;
  refetch(): void;
  /** Insert a locally-created row until the server echoes it back. */
  addOptimistic(item: T): void;
  removeOptimistic(id: string): void;
}

export interface LiveQueryOptions<T = LiveRow> {
  /** Hydrated rows to draw while the first answer is in flight. */
  initial?: T[];
  /** `false` reads the query without a server subscription, so no ops follow it. Default `true`. */
  subscribe?: boolean;
  /** The records the read is expected to hold, drawn from storage before its own list is kept. */
  ids?: readonly string[];
  /** Whether an answer goes to storage, read from its rows; storage keeps what it had for one that doesn't. */
  keeps?: (rows: readonly ServerRow[]) => boolean;
}

interface StoreInternal {
  reset(): void;
  holder: Holder;
  /** The store's list in storage. */
  listKey(): string;
}

/** The page's retained stores. */
const registry = new Set<StoreInternal>();
const internals = new WeakMap<LiveQueryStore<any>, StoreInternal>();
/** Bumped when the page's records go; a store released since draws nothing it held. */
let epoch = 0;

/** This card's `PageHooks.reset`: rows were read as another account, so every record goes. */
export function resetStores(): void {
  epoch++;
  forgetRecords();
  for (const store of registry) store.reset();
}

/** The store's list in storage; a kept create names it to show in the store from every page. */
export function listKeyOf(store: LiveQueryStore<any>): string | null {
  return internals.get(store)?.listKey() ?? null;
}

/** The holders of every retained store, redrawn when the page's waiting changes do. */
export function retainedHolders(): Holder[] {
  return [...registry].map((store) => store.holder);
}

/** The read a chain names: its steps as the wire sends them, every `select` naming `updatedAt`. */
function requestOf(
  chain: QueryChain<unknown>,
  { ids = [], subscribe: wanted }: Pick<LiveQueryOptions, "ids" | "subscribe">,
): ReadRequest {
  const type = chain.__modelType;
  const steps = chain.__steps.map((step) => ({ method: step.method, args: serializeLazyQueryArgs(step.args) }));
  const selects = steps.filter((step) => step.method === "select");
  const last = selects[selects.length - 1];
  if (last && !selects.some((step) => step.args.flat().includes("updatedAt"))) last.args = [...last.args, "updatedAt"];
  const subscribe = wanted !== false && chain.__subscribe !== false;
  return { key: `${type}:${JSON.stringify(steps)}${subscribe ? "" : ":nosub"}`, type, steps, subscribe, ids };
}

export function createLiveQuery<T extends LiveRow>(
  chainFactory: () => QueryChain<T>,
  options: LiveQueryOptions<T> = {},
): LiveQueryStore<T> {
  let items: T[] = options.initial ?? [];
  let optimistic: T[] = [];
  let status: LiveStatus = options.initial ? "ready" : "loading";
  let error: Error | null = null;
  let total = items.length;
  let answers = 0;
  let drawn = !!options.initial;
  let snap: LiveSnapshot<T> | null = null;
  let storeEpoch = epoch;

  let chain: QueryChain<T> | null = null;
  let request: ReadRequest | null = null;
  let fields: ReadonlySet<string> | null = null;
  /** The engine's rows this store last saw, each as the page's object for it. */
  let seen = new WeakMap<ServerRow, T>();
  let seenAnswers = 0;
  let live = false;

  let refs = 0;
  let release: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    snap = null;
    for (const fn of listeners) fn();
  };
  const unlist = (id: string) => {
    const before = items.length + optimistic.length;
    items = items.filter((i) => i.id !== id);
    optimistic = optimistic.filter((o) => o.id !== id && o.tmp !== id);
    if (items.length + optimistic.length === before) return;
    holdItems();
    notify();
  };
  const holder = { republish: notify, unlist };

  /** Its rows, its optimistic rows and waiting creates, less every row a waiting delete names. */
  const merged = (): T[] => {
    const removes = waitingRemoves();
    const creates = request ? (waitingCreates(request.key, hydrate) as T[]) : [];
    if (optimistic.length === 0 && creates.length === 0 && removes.size === 0) return items;
    const ids = new Set(items.map((i) => i.id).filter(Boolean));
    const tmps = new Set(items.map((i) => i.tmp).filter(Boolean));
    const removed = (row: T) =>
      [row.id, row.tmp].some((id) => id && removes.has(`${request?.type}:${id}`));
    return [
      ...items,
      ...[...optimistic, ...creates].filter(
        (o) => !(o.id && ids.has(o.id)) && !(o.tmp && tmps.has(o.tmp)),
      ),
    ].filter((row) => !removed(row));
  };

  /** `holder` lists the store's items, with the page's waiting patches laid over them. */
  const holdItems = () => {
    hold(holder, items, fields);
    layOver(items);
  };

  /** Server rows arrived — drop optimistic entries the server now owns. */
  const drainOptimistic = () => {
    if (optimistic.length === 0) return;
    const ids = new Set(items.map((i) => i.id).filter(Boolean));
    const tmps = new Set(items.map((i) => i.tmp).filter(Boolean));
    optimistic = optimistic.filter(
      (o) => !(o.id && ids.has(o.id)) && !(o.tmp && tmps.has(o.tmp)),
    );
  };

  const hydrate = (data: Record<string, unknown>): T | null => {
    const ModelClass = chain?.__modelClass as unknown as HydratingClass<T> | undefined;
    if (!ModelClass || typeof ModelClass.hydrate !== "function") return null;
    const { client } = page();
    const BoundModel = client.bind(ModelClass as unknown as typeof Model) as unknown as HydratingClass<T>;
    return BoundModel.hydrate(client.adapter, data);
  };

  /**
   * The page's object for each row: a row seen before is the object it became; a new row merges
   * into the page's record for it over the fields this read asks for, or becomes one.
   */
  const reconcile = (rows: readonly ServerRow[]): T[] => {
    const byId = new Map(items.filter((item) => item.id).map((item) => [item.id, item]));
    const next = rows.flatMap((row) => {
      const known = seen.get(row);
      if (known) return [known];
      const fresh = hydrate(row);
      if (!fresh) return [];
      const existing =
        (fresh.id && (recordFor(fresh, fields) ?? byId.get(fresh.id) ?? optimistic.find((o) => o.id === fresh.id))) ||
        (fresh.tmp && optimistic.find((o) => o.tmp === fresh.tmp));
      if (existing) mergeRow(existing, fresh, row, fields, holder);
      seen.set(row, existing || fresh);
      return [existing || fresh];
    });
    return next.length === items.length && next.every((item, index) => item === items[index]) ? items : next;
  };

  const view: ReadView = {
    changed(read: Read) {
      invalidate();
      // The caller's rows stand until the read holds an answer of its own.
      if (items === options.initial && !read.drawn && !read.error) return;
      const before = { items, answers, status, error, total, drawn };
      if (read.answers !== seenAnswers) answers++;
      seenAnswers = read.answers;
      ({ status, error, total, drawn, live } = read);
      items = reconcile(read.rows);
      drainOptimistic();
      holdItems();
      // Retaining a read that hasn't moved since this store last drew it redraws nothing.
      const after = { items, answers, status, error, total, drawn };
      if ((Object.keys(after) as (keyof typeof after)[]).some((key) => after[key] !== before[key])) notify();
    },
    keeps: options.keeps,
  };

  /** The page's records went since this store last drew: it holds nothing of them. */
  const invalidate = () => {
    if (storeEpoch === epoch) return;
    storeEpoch = epoch;
    seen = new WeakMap();
    items = [];
    optimistic = [];
    status = "loading";
    error = null;
    total = 0;
    drawn = false;
    snap = null;
  };

  const internal: StoreInternal = {
    // A retained store keeps what it drew: the engine's next word on its read says what stays.
    reset: () => {
      storeEpoch = epoch;
    },
    holder,
    // A store this page never retained still names its list, for a create saved into it.
    listKey: () => (request ?? requestOf(chainFactory(), options)).key,
  };

  const store: LiveQueryStore<T> = {
    snapshot() {
      invalidate();
      if (!snap) snap = { items: merged(), status, error, total, answers, drawn };
      return snap;
    },
    retain(onChange: () => void) {
      "background only";
      invalidate();
      listeners.add(onChange);
      refs++;
      if (refs === 1) {
        chain = chainFactory();
        request = requestOf(chain, options);
        fields = fieldsOf(request.steps as never);
        registry.add(internal);
        live = false;
        const before = answers;
        release = page().retain(request, view);
        // A read the engine kept live is current: retaining it counts as an answer.
        if (live && answers === before) {
          answers++;
          notify();
        }
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        listeners.delete(onChange);
        refs--;
        if (refs > 0) return;
        registry.delete(internal);
        release?.();
        release = null;
      };
    },
    refetch() {
      "background only";
      if (refs > 0 && request) page().refetch(request.key);
    },
    addOptimistic(item: T) {
      optimistic = [...optimistic, item];
      notify();
    },
    removeOptimistic: unlist,
  };
  internals.set(store, internal);
  return store;
}
