/**
 * The page's rows: one object per record across stores, an answer merged over exactly the
 * fields its read asked for, and storage drawing and keeping rows per account.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RowStorage, StoredList, StoredRow } from "../rows";
import { page, reset, client, server, retain, type Data } from "./harness";

const TITLES = [{ method: "select", args: ["id", "title"] }];

beforeEach(() => {
  vi.useFakeTimers();
  reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("one object per record", () => {
  it("hands every store the same object, and a merge redraws the other stores", async () => {
    const serve = server({ show: [{ id: "s1", title: "Night Shift", premise: "Alibi" }] });
    const home = await page(client(serve));
    const list = home.shows(TITLES);
    const whole = home.shows();
    const listed = retain(list);
    await vi.advanceTimersByTimeAsync(1);
    const held = retain(whole);
    await vi.advanceTimersByTimeAsync(1);

    const show = list.snapshot().items[0]!;
    expect(whole.snapshot().items[0]).toBe(show);
    expect(show.premise).toBe("Alibi");

    serve.tables.show![0]!.title = "Night Shift Alibi";
    list.refetch();
    const before = held.changes();
    await vi.advanceTimersByTimeAsync(1);
    expect(show.title).toBe("Night Shift Alibi");
    expect(show.premise).toBe("Alibi");
    expect(held.changes()).toBeGreaterThan(before);
    expect(listed.changes()).toBeGreaterThan(0);
  });

  it("keeps a selection without ids out of the records", async () => {
    const serve = server({ show: [{ id: "s1", title: "A" }] });
    const answer = serve.answer;
    serve.answer = (entry) => {
      const sent = answer(entry);
      return entry.steps.length ? { ...sent, items: [{ title: "A" }] } : { ...sent, items: [{ id: "s1", title: "B" }] };
    };
    const home = await page(client(serve));
    const titles = home.shows([{ method: "select", args: ["title"] }]);
    const whole = home.shows();
    retain(titles);
    retain(whole);
    await vi.advanceTimersByTimeAsync(1);
    expect(titles.snapshot().items[0]!.title).toBe("A");
    expect(whole.snapshot().items[0]!.title).toBe("B");
  });
});

describe("projection-exact merge", () => {
  it("removes a selected field the row lacks and keeps the fields the read didn't ask for", async () => {
    const serve = server({ show: [{ id: "s1", title: "T", premise: "P" }] });
    const home = await page(client(serve));
    const whole = home.shows();
    retain(whole);
    await vi.advanceTimersByTimeAsync(1);
    const show = whole.snapshot().items[0]!;

    serve.tables.show = [{ id: "s1" }];
    const picked = home.shows([{ method: "select", args: ["id", "premise"] }]);
    retain(picked);
    await vi.advanceTimersByTimeAsync(1);
    expect(picked.snapshot().items[0]).toBe(show);
    expect("premise" in show).toBe(false);
    expect(show.title).toBe("T");
  });

  it("removes a selected field with a default the row lacks, rather than resetting it", async () => {
    const serve = server({ show: [{ id: "s1", title: "T", premise: "P" }] });
    const home = await page(client(serve));
    const whole = home.shows();
    retain(whole);
    await vi.advanceTimersByTimeAsync(1);
    const show = whole.snapshot().items[0]!;

    serve.tables.show = [{ id: "s1" }];
    retain(home.shows(TITLES));
    await vi.advanceTimersByTimeAsync(1);
    expect("title" in show).toBe(false);
    expect(show.premise).toBe("P");
  });

  it("takes a whole row as authoritative without a select", async () => {
    const serve = server({ show: [{ id: "s1", title: "T", premise: "P" }] });
    const home = await page(client(serve));
    const whole = home.shows();
    retain(whole);
    await vi.advanceTimersByTimeAsync(1);
    const show = whole.snapshot().items[0]!;

    serve.tables.show = [{ id: "s1", title: "T2" }];
    whole.refetch();
    await vi.advanceTimersByTimeAsync(1);
    expect(whole.snapshot().items[0]).toBe(show);
    expect(show.title).toBe("T2");
    expect("premise" in show).toBe(false);
  });
});

describe("storage", () => {
  function storage(kept: { user: string | null; list: StoredList | null; rows: StoredRow[] }) {
    const writes: Array<Parameters<RowStorage["write"]>[0]> = [];
    const slot: RowStorage = {
      read: async () => kept,
      write: async (batch) => void writes.push(batch),
      waiting: async () => ({ user: kept.user, writes: [] }),
    };
    return { slot, writes };
  }
  /** A row a whole read kept, at the version it holds. */
  const stored = (id: string, title: string): StoredRow => ({ type: "show", id, data: JSON.stringify({ id, title, "__held:*": "" }) });
  /** A line whose session is still settling, and whose answers wait for `answer()`. */
  function settling(rows: Data[]) {
    const line = client(server({ show: rows }));
    line.session.state = { ...line.session.state, status: "pending", userId: null };
    let answer = () => {};
    const asked = line.resync.getMockImplementation()!;
    line.resync.mockImplementation((entries) => new Promise((done) => (answer = () => done(asked(entries)))));
    return { line, answer: () => answer() };
  }

  it("draws stored rows as loading while the session settles, then answers and keeps them as the account", async () => {
    const { line, answer } = settling([{ id: "s1", title: "Fresh" }]);
    const { slot } = storage({ user: "u1", list: null, rows: [stored("s1", "Kept")] });
    const home = await page(line, slot);
    const store = home.shows([], { ids: ["s1"] });
    retain(store);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.snapshot().status).toBe("loading");
    const drawn = store.snapshot().items[0]!;
    expect(drawn.title).toBe("Kept");

    line.settle("authenticated", "u1");
    expect(store.snapshot().items[0]).toBe(drawn);
    await vi.advanceTimersByTimeAsync(1);
    expect(line.resync.mock.calls[0]![0][0]).toHaveProperty("have", { s1: "" });
    answer();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.snapshot()).toMatchObject({ status: "ready", total: 1 });
    expect(store.snapshot().items[0]).toBe(drawn);
    expect(drawn.title).toBe("Fresh");
  });

  it("draws stored rows the session's settling overtook, and asks with what they hold", async () => {
    const { line } = settling([{ id: "s1", title: "Fresh" }]);
    let kept = () => {};
    const { slot } = storage({ user: "u1", list: null, rows: [stored("s1", "Kept")] });
    const read = slot.read;
    slot.read = (request) => new Promise((done) => (kept = () => done(read(request))));
    const home = await page(line, slot);
    const store = home.shows([], { ids: ["s1"] });
    retain(store);
    line.settle("authenticated", "u1");
    await vi.advanceTimersByTimeAsync(1);
    expect(line.resync).not.toHaveBeenCalled();
    kept();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.snapshot().items[0]!.title).toBe("Kept");
    expect(line.resync).toHaveBeenCalledTimes(1);
    expect(line.resync.mock.calls[0]![0][0]).toHaveProperty("have", { s1: "" });
  });

  it("drops stored rows when the session settles as another account", async () => {
    const { line } = settling([]);
    const { slot } = storage({ user: "u1", list: null, rows: [stored("s1", "Kept")] });
    const home = await page(line, slot);
    const store = home.shows([], { ids: ["s1"] });
    retain(store);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.snapshot().items).toHaveLength(1);

    line.settle("authenticated", "u2");
    expect(store.snapshot().items).toHaveLength(0);
  });

  it("writes an answer's rows and its list once per tick, tagged with the account", async () => {
    const { slot, writes } = storage({ user: "u1", list: null, rows: [] });
    const home = await page(client(server({ show: [{ id: "s1", title: "T" }, { id: "s2", title: "U" }] })), slot);
    retain(home.shows());
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(writes).toHaveLength(1);
    expect(writes[0]!.user).toBe("u1");
    expect(writes[0]!.lists).toEqual([{ key: "show:[]", type: "show", ids: '["s1","s2"]', total: 2 }]);
    expect(writes[0]!.rows[0]).toMatchObject({ type: "show", id: "s1", fields: null });
    expect(JSON.parse(writes[0]!.rows[0]!.data)).toEqual({ id: "s1", title: "T", "__held:*": "" });
  });

  it("writes a selection's own fields only, named, with updatedAt, so storage keeps the rest of a fuller row", async () => {
    const { slot, writes } = storage({ user: "u1", list: null, rows: [] });
    const home = await page(client(server({ show: [{ id: "s1", title: "T", premise: "P", updatedAt: "1" }] })), slot);
    retain(home.shows(TITLES));
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);

    const row = writes[0]!.rows[0]!;
    expect([...row.fields!].sort()).toEqual(["id", "title", "updatedAt"]);
    expect(JSON.parse(row.data)).toEqual({ id: "s1", title: "T", updatedAt: "1", "__held:id,title,updatedAt": String(Date.parse("1")) });
  });

  it("draws a row a narrower read kept, and asks for it whole", async () => {
    const { line } = settling([{ id: "s1", title: "T", premise: "P", updatedAt: "1" }]);
    const narrow = { id: "s1", title: "T", updatedAt: "1", "__held:id,title,updatedAt": "1" };
    const { slot } = storage({ user: "u1", list: null, rows: [{ type: "show", id: "s1", data: JSON.stringify(narrow) }] });
    const home = await page(line, slot);
    const store = home.shows([], { ids: ["s1"] });
    retain(store);
    line.settle("authenticated", "u1");
    await vi.advanceTimersByTimeAsync(1);
    expect(line.resync.mock.calls[0]![0][0]).toHaveProperty("have", {});
  });

  it("draws a row a whole read kept, and asks again for a read naming a derived field", async () => {
    const { line } = settling([{ id: "s1", title: "T", updatedAt: "1" }]);
    const whole = { id: "s1", title: "T", updatedAt: "1", "__held:*": "1" };
    const { slot } = storage({ user: "u1", list: null, rows: [{ type: "show", id: "s1", data: JSON.stringify(whole) }] });
    const home = await page(line, slot);
    const store = home.shows([{ method: "select", args: ["id", "title", "parts.text"] }], { ids: ["s1"] });
    retain(store);
    line.settle("authenticated", "u1");
    await vi.advanceTimersByTimeAsync(1);
    expect(store.snapshot().items[0]!.title).toBe("T");
    expect(line.resync.mock.calls[0]![0][0]).toHaveProperty("have", {});
  });

  it("writes only the answers every store on its read keeps", async () => {
    const { slot, writes } = storage({ user: "u1", list: null, rows: [] });
    const serve = server({ show: [{ id: "s1", title: "Writing" }] });
    const home = await page(client(serve), slot);
    const store = home.shows([], { keeps: (rows: Data[]) => rows.every((row) => row.title !== "Writing") });
    retain(store);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(0);

    serve.tables.show = [{ id: "s1", title: "Written" }];
    store.refetch();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.rows[0]!.data)).toEqual({ id: "s1", title: "Written", "__held:*": "" });
  });

  it("draws a kept list in its order on the next launch", async () => {
    const { line } = settling([]);
    const list = { key: "show:[]", type: "show", ids: '["s2","s1"]', total: 2 };
    const { slot } = storage({ user: "u1", list, rows: [stored("s1", "One"), stored("s2", "Two")] });
    const home = await page(line, slot);
    const store = home.shows();
    retain(store);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.snapshot().items.map((show) => show.title)).toEqual(["Two", "One"]);
    expect(store.snapshot()).toMatchObject({ status: "loading", total: 2 });
  });

  it("draws nothing of a kept list storage lost a row of, and waits for the server", async () => {
    const { line } = settling([]);
    const list = { key: "show:[]", type: "show", ids: '["s2","s1"]', total: 2 };
    const { slot } = storage({ user: "u1", list, rows: [stored("s1", "One")] });
    const home = await page(line, slot);
    const store = home.shows();
    retain(store);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.snapshot()).toMatchObject({ items: [], status: "loading", drawn: false });
  });

  it("draws a kept empty list as an answer, which a read with nothing kept is not", async () => {
    const { line } = settling([]);
    const { slot } = storage({ user: "u1", list: { key: "show:[]", type: "show", ids: "[]", total: 0 }, rows: [] });
    const home = await page(line, slot);
    const store = home.shows();
    retain(store);
    expect(store.snapshot().drawn).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.snapshot()).toMatchObject({ items: [], status: "loading", drawn: true });
  });
});
