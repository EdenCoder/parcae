/**
 * One engine for every page: a read is asked once and counted across pages, patched in place, kept
 * live a grace after the last page lets go, each asked again on its own on reconnect, and let go of
 * whole when Lynx destroys a page's card.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { page, reset, client, server, retain } from "./harness";

const TITLES = [{ method: "select", args: [["id", "title"]] }];

beforeEach(() => {
  vi.useFakeTimers();
  reset();
});

afterEach(() => {
  vi.useRealTimers();
});

it("asks once for a read two pages hold, and stops hearing it only after both and the grace", async () => {
  const line = client(server({ show: [{ id: "s1", title: "Night Shift", updatedAt: "1" }] }));
  const home = await page(line);
  const create = await page(line);
  const a = retain(home.shows(TITLES));
  const b = retain(create.shows(TITLES));
  await vi.advanceTimersByTimeAsync(1);
  expect(line.resync).toHaveBeenCalledTimes(1);
  expect(line.resync.mock.calls[0]![0]).toHaveLength(1);
  const [hash] = line.pushed();

  b.release();
  a.release();
  await vi.advanceTimersByTimeAsync(59_000);
  expect(line.pushed()).toEqual([hash]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(line.pushed()).toEqual([]);
});

it("draws a read kept live at once when a page opens again, as one more answer, with no request", async () => {
  const line = client(server({ show: [{ id: "s1", title: "Night Shift", updatedAt: "1" }] }));
  const home = await page(line);
  retain(home.shows(TITLES));
  await vi.advanceTimersByTimeAsync(1);

  const create = await page(line);
  const store = create.shows(TITLES);
  const opened = retain(store);
  expect(store.snapshot()).toMatchObject({ status: "ready", answers: 1, drawn: true });
  expect(store.snapshot().items[0]!.title).toBe("Night Shift");
  opened.release();
  const again = retain(store);
  expect(store.snapshot().answers).toBe(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(line.resync).toHaveBeenCalledTimes(1);
  again.release();
});

it("patches a pushed update in place: the moved row is a new object, the rest stay", async () => {
  const line = client(server({ show: [{ id: "s1", title: "A", updatedAt: "1" }, { id: "s2", title: "B", updatedAt: "1" }] }));
  const home = await page(line);
  const store = home.shows();
  const held = retain(store);
  await vi.advanceTimersByTimeAsync(1);
  const [first, second] = store.snapshot().items;
  const [hash] = line.pushed();

  line.push(hash!, { ops: [{ op: "update", id: "s1", patch: [{ op: "replace", path: "/title", value: "A2" }] }] });
  expect(store.snapshot().items[0]).toBe(first);
  expect(first!.title).toBe("A2");
  expect(second!.title).toBe("B");
  expect(store.snapshot().answers).toBe(2);
  expect(line.resync).toHaveBeenCalledTimes(1);

  line.push(hash!, { ops: [{ op: "remove", id: "s1" }, { op: "add", id: "s3", data: { id: "s3", title: "C" } }], order: ["s3", "s2"] });
  expect(store.snapshot().items.map((show) => show.title)).toEqual(["C", "B"]);
  held.release();
});

it("asks again for each retained read on its own on reconnect, saying what each holds", async () => {
  const line = client(server({ show: [{ id: "s1", title: "A", updatedAt: "1" }] }));
  const home = await page(line);
  retain(home.shows());
  retain(home.shows(TITLES));
  const hidden = retain(home.shows([{ method: "where", args: [{ title: "A" }] }]));
  await vi.advanceTimersByTimeAsync(1);
  hidden.release();

  line.resync.mockClear();
  line.emit("disconnected");
  line.emit("resync-required");
  await vi.advanceTimersByTimeAsync(1);
  const asks = line.resync.mock.calls.map(([entries]) => entries);
  expect(asks.map((entries) => entries.length)).toEqual([1, 1]);
  expect(asks.every(([entry]) => entry!.have && "s1" in entry!.have)).toBe(true);
});

it("lets go of every read and listener a page held when Lynx destroys its card, crashed or not", async () => {
  const line = client(server({ show: [{ id: "s1", title: "A", updatedAt: "1" }] }));
  const home = await page(line);
  retain(home.shows(TITLES));
  const create = await page(line);
  retain(create.shows());
  create.lynx.page().on("connected", () => {});
  await vi.advanceTimersByTimeAsync(1);
  expect(line.pushed()).toHaveLength(2);
  const listeners = line.listeners("connected");

  create.destroy();
  expect(line.listeners("connected")).toBe(listeners - 1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(line.pushed()).toHaveLength(1);
});
