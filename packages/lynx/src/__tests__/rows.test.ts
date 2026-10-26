/**
 * The page's rows: one object per record across stores, an answer merged over exactly the
 * fields its read asked for, and the storage slot drawing and keeping rows per account.
 */

import { Model, type Ref } from "@parcae/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { provideClient } from "../client-registry";
import { createLiveQuery, resetLiveQueries, type QueryChain } from "../live-query";
import { provideRowStorage, type RowStorage, type StoredList, type StoredRow } from "../rows";

class Cover extends Model {
  static type = "cover" as const;
  url = "";
}

class Show extends Model {
  static type = "show" as const;
  static __schema = { cover: { kind: "ref", target: Cover } } as any;
  title = "";
  declare premise?: string;
  declare cover: Ref<Cover>;
}

type Data = Record<string, unknown>;
const adapter = {} as any;

/** A read of shows answering `rows()` each time, with its steps and a query hash. */
function read(rows: () => Data[], steps: Array<{ method: string; args: unknown[] }> = []) {
  const chain: QueryChain<Show> = {
    find: async () => {
      const sent = rows();
      const models = sent.map((row) => Show.hydrate(adapter, structuredClone(row)));
      Object.defineProperty(models, "__rows", { value: sent });
      Object.defineProperty(models, "__queryHash", { value: `H${steps.length}` });
      Object.defineProperty(models, "__totalCount", { value: models.length + 10 });
      return models;
    },
    __modelClass: Show,
    __adapter: adapter,
    __modelType: "show",
    __steps: steps,
  };
  return chain;
}

const SEVEN = [{ method: "select", args: ["id", "title"] }];

const releases: Array<() => void> = [];
function retain(store: { retain(fn: () => void): () => void }) {
  let changes = 0;
  releases.push(store.retain(() => changes++));
  return () => changes;
}

beforeEach(() => {
  vi.useFakeTimers();
  provideClient(() => ({ subscribe: () => () => {}, withQuerySubscriptions: (run: () => Promise<unknown>) => run() }) as never);
  resetLiveQueries(true, "u1");
});

afterEach(async () => {
  while (releases.length) releases.pop()!();
  await vi.advanceTimersByTimeAsync(0);
  provideRowStorage(null);
  vi.useRealTimers();
});

describe("one object per record", () => {
  it("hands every store the same object, and a merge redraws the other stores", async () => {
    let title = "Night Shift";
    const list = createLiveQuery(() => read(() => [{ id: "s1", title }], SEVEN));
    const whole = createLiveQuery(() => read(() => [{ id: "s1", title, premise: "Alibi" }]));
    const listChanges = retain(list);
    await vi.advanceTimersByTimeAsync(0);
    const wholeChanges = retain(whole);
    await vi.advanceTimersByTimeAsync(0);

    const show = list.snapshot().items[0]!;
    expect(whole.snapshot().items[0]).toBe(show);
    expect(show.premise).toBe("Alibi");

    title = "Night Shift Alibi";
    list.refetch();
    const before = wholeChanges();
    await vi.advanceTimersByTimeAsync(0);
    expect(show.title).toBe("Night Shift Alibi");
    expect(show.premise).toBe("Alibi");
    expect(wholeChanges()).toBeGreaterThan(before);
    expect(listChanges()).toBeGreaterThan(0);
  });

  it("keeps a selection without ids out of the records", async () => {
    const titles = createLiveQuery(() => read(() => [{ title: "A" }], [{ method: "select", args: ["title"] }]));
    const whole = createLiveQuery(() => read(() => [{ id: "s1", title: "B" }]));
    retain(titles);
    retain(whole);
    await vi.advanceTimersByTimeAsync(0);
    expect(titles.snapshot().items[0]!.title).toBe("A");
    expect(whole.snapshot().items[0]!.title).toBe("B");
  });
});

describe("projection-exact merge", () => {
  it("removes a selected field the row lacks and keeps the fields the read didn't ask for", async () => {
    let row: Data = { id: "s1", title: "T", premise: "P", cover: { id: "c1", url: "a.jpg" }, $cover: "c1" };
    const whole = createLiveQuery(() => read(() => [row]));
    const picked = createLiveQuery(() => read(() => [row], [{ method: "select", args: ["id", "premise"] }]));
    retain(whole);
    await vi.advanceTimersByTimeAsync(0);
    const show = whole.snapshot().items[0]!;
    const cover = show.cover;

    row = { id: "s1" };
    retain(picked);
    await vi.advanceTimersByTimeAsync(0);
    expect(picked.snapshot().items[0]).toBe(show);
    expect("premise" in show).toBe(false);
    expect(show.title).toBe("T");
    expect(show.cover).toBe(cover);
  });

  it("removes a selected field with a default the row lacks, rather than resetting it", async () => {
    let row: Data = { id: "s1", title: "T", premise: "P" };
    const whole = createLiveQuery(() => read(() => [row]));
    const picked = createLiveQuery(() => read(() => [row], [{ method: "select", args: ["id", "title"] }]));
    retain(whole);
    await vi.advanceTimersByTimeAsync(0);
    const show = whole.snapshot().items[0]!;

    row = { id: "s1" };
    retain(picked);
    await vi.advanceTimersByTimeAsync(0);
    expect("title" in show).toBe(false);
    expect(show.premise).toBe("P");
  });

  it("takes a whole row as authoritative without a select", async () => {
    let row: Data = { id: "s1", title: "T", premise: "P" };
    const whole = createLiveQuery(() => read(() => [row]));
    retain(whole);
    await vi.advanceTimersByTimeAsync(0);
    const show = whole.snapshot().items[0]!;

    row = { id: "s1", title: "T2" };
    whole.refetch();
    await vi.advanceTimersByTimeAsync(0);
    expect(whole.snapshot().items[0]).toBe(show);
    expect(show.title).toBe("T2");
    expect("premise" in show).toBe(false);
  });
});

describe("storage slot", () => {
  function storage(kept: { user: string | null; list: StoredList | null; rows: StoredRow[] }) {
    const writes: Array<Parameters<RowStorage["write"]>[0]> = [];
    const slot: RowStorage = { read: async () => kept, write: (batch) => writes.push(batch) };
    provideRowStorage(slot);
    return writes;
  }
  const stored = (id: string, title: string): StoredRow => ({
    type: "show",
    id,
    data: JSON.stringify({ id, title, cover: { id: "c1", url: "a.jpg" }, $cover: "c1" }),
  });

  it("draws stored rows as loading while the session settles, then answers and keeps them as the account", async () => {
    storage({ user: "u1", list: null, rows: [stored("s1", "Kept")] });
    resetLiveQueries(false);
    const store = createLiveQuery(() => read(() => [{ id: "s1", title: "Fresh" }]), { ids: ["s1"] });
    retain(store);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.snapshot().status).toBe("loading");
    expect(store.snapshot().items[0]!.title).toBe("Kept");
    expect((store.snapshot().items[0]!.cover as Cover).url).toBe("a.jpg");

    const drawn = store.snapshot().items[0];
    resetLiveQueries(true, "u1");
    expect(store.snapshot().items[0]).toBe(drawn);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.snapshot()).toMatchObject({ status: "ready", total: 11 });
    expect(store.snapshot().items[0]).toBe(drawn);
    expect(drawn!.title).toBe("Fresh");
  });

  it("drops stored rows when the session settles as another account", async () => {
    storage({ user: "u1", list: null, rows: [stored("s1", "Kept")] });
    resetLiveQueries(false);
    const store = createLiveQuery(() => read(() => []), { ids: ["s1"] });
    retain(store);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.snapshot().items).toHaveLength(1);

    resetLiveQueries(true, "u2");
    expect(store.snapshot().items).toHaveLength(0);
  });

  it("writes an answer's rows and its list once per tick, tagged with the account", async () => {
    const writes = storage({ user: "u1", list: null, rows: [] });
    const store = createLiveQuery(() =>
      read(() => [{ id: "s1", title: "T", cover: { id: "c1", url: "a.jpg" }, $cover: "c1" }, { id: "s2", title: "U" }]),
    );
    retain(store);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(writes).toHaveLength(1);
    expect(writes[0]!.user).toBe("u1");
    expect(writes[0]!.lists).toEqual([
      { key: 'show:[]', type: "show", ids: '["s1","s2"]', total: 12 },
    ]);
    expect(writes[0]!.rows[0]).toMatchObject({ type: "show", id: "s1", fields: null });
    expect(JSON.parse(writes[0]!.rows[0]!.data)).toEqual({
      id: "s1",
      title: "T",
      cover: { id: "c1", url: "a.jpg" },
      $cover: "c1",
    });
  });

  it("writes a selection's own fields only, named, so storage keeps the rest of a fuller row", async () => {
    const writes = storage({ user: "u1", list: null, rows: [] });
    const whole = createLiveQuery(() => read(() => [{ id: "s1", title: "T", premise: "P" }]));
    retain(whole);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const picked = createLiveQuery(() =>
      read(() => [{ id: "s1", cover: { id: "c2", url: "b.jpg" }, $cover: "c2", extra: 1 }], [
        { method: "select", args: ["id", "title"] },
        { method: "expand", args: ["cover"] },
      ]),
    );
    retain(picked);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(writes).toHaveLength(2);
    const row = writes[1]!.rows[0]!;
    expect([...row.fields!].sort()).toEqual(["cover", "id", "title"]);
    expect(JSON.parse(row.data)).toEqual({ id: "s1", cover: { id: "c2", url: "b.jpg" }, $cover: "c2" });
  });

  it("writes only the answers its read keeps", async () => {
    const writes = storage({ user: "u1", list: null, rows: [] });
    let title = "Writing";
    const store = createLiveQuery(() => read(() => [{ id: "s1", title }]), {
      keeps: (shows) => shows.every((show) => show.title !== "Writing"),
    });
    retain(store);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(0);

    title = "Written";
    store.refetch();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.rows[0]!.data)).toEqual({ id: "s1", title: "Written" });
  });

  it("draws a kept list in its order on the next launch", async () => {
    storage({
      user: "u1",
      list: { key: "show:[]", type: "show", ids: '["s2","s1"]', total: 2 },
      rows: [stored("s1", "One"), stored("s2", "Two")],
    });
    const store = createLiveQuery(() => read(() => []));
    resetLiveQueries(false);
    retain(store);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.snapshot().items.map((show) => show.title)).toEqual(["Two", "One"]);
    expect(store.snapshot()).toMatchObject({ status: "loading", total: 2 });
  });
});
