/**
 * A store's own state over the engine's read: its status through failures, the optimistic rows it
 * shows until the server holds them, and answers to an identity it no longer reads as.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { page, reset, client, server, retain } from "./harness";

beforeEach(() => {
  vi.useFakeTimers();
  reset();
});

afterEach(() => {
  vi.useRealTimers();
});

it("reports error when the first answer fails, and stays ready with its rows when a later one does", async () => {
  const phone = client(server({ show: [{ id: "s1", title: "A" }] }));
  phone.resync.mockRejectedValueOnce(new Error("Disconnected"));
  const home = await page(phone);
  const store = home.shows();
  const { release } = retain(store);
  await vi.advanceTimersByTimeAsync(1);
  expect(store.snapshot()).toMatchObject({ status: "error", items: [] });

  store.refetch();
  await vi.advanceTimersByTimeAsync(1);
  expect(store.snapshot()).toMatchObject({ status: "ready", error: null });
  phone.resync.mockRejectedValueOnce(new Error("Disconnected"));
  store.refetch();
  await vi.advanceTimersByTimeAsync(1);
  expect(store.snapshot().status).toBe("ready");
  expect(store.snapshot().items).toHaveLength(1);

  // Retained again after the read's grace, the store asks afresh.
  release();
  await vi.advanceTimersByTimeAsync(60_000);
  phone.resync.mockRejectedValueOnce(new Error("Disconnected"));
  retain(store);
  await vi.advanceTimersByTimeAsync(1);
  expect(store.snapshot()).toMatchObject({ status: "ready", error: { message: "Disconnected" } });
  expect(store.snapshot().items).toHaveLength(1);
});

it("shows an optimistic row until the server holds it, then keeps the same object", async () => {
  const serve = server({ show: [{ id: "s1", title: "A" }] });
  const phone = client(serve);
  const home = await page(phone);
  const store = home.shows();
  retain(store);
  await vi.advanceTimersByTimeAsync(1);
  const [hash] = phone.pushed();
  const Bound = phone.bind(home.Show);
  const draft = Bound.hydrate(phone.adapter, { id: "s2", title: "Draft" });
  store.addOptimistic(draft);
  expect(store.snapshot().items.map((show) => show.title)).toEqual(["A", "Draft"]);

  phone.push(hash!, { ops: [{ op: "add", id: "s2", data: { id: "s2", title: "Saved" } }] });
  expect(store.snapshot().items[1]).toBe(draft);
  expect(draft.title).toBe("Saved");

  store.removeOptimistic("s2");
  expect(store.snapshot().items).toHaveLength(1);
});

it("drops an answer to the identity the session left", async () => {
  const phone = client(server({ show: [{ id: "s1", title: "Theirs" }] }));
  let answer = () => {};
  const asked = phone.resync.getMockImplementation()!;
  phone.resync.mockImplementationOnce((entries) => new Promise((done) => (answer = () => done(asked(entries)))));
  const home = await page(phone);
  const store = home.shows();
  retain(store);
  await vi.advanceTimersByTimeAsync(1);

  phone.settle("authenticated", "u2");
  answer();
  await vi.advanceTimersByTimeAsync(1);
  expect(phone.resync).toHaveBeenCalledTimes(2);
  expect(store.snapshot()).toMatchObject({ status: "ready", answers: 1 });
});

it("draws the caller's rows as ready through a failed ask until the first answer lands on them", async () => {
  const phone = client(server({ show: [{ id: "s1", title: "Server" }] }));
  const home = await page(phone);
  const mine = phone.bind(home.Show).hydrate(phone.adapter, { id: "s1", title: "Mine" });
  const store = home.shows([], { initial: [mine] });
  expect(store.snapshot()).toMatchObject({ status: "ready", total: 1, drawn: true, items: [mine] });

  phone.resync.mockRejectedValueOnce(new Error("Disconnected"));
  retain(store);
  await vi.advanceTimersByTimeAsync(1);
  expect(store.snapshot()).toMatchObject({ status: "ready", error: { message: "Disconnected" } });
  expect(store.snapshot().items[0]).toBe(mine);

  store.refetch();
  await vi.advanceTimersByTimeAsync(1);
  expect(store.snapshot().error).toBeNull();
  expect(store.snapshot().items[0]).toBe(mine);
  expect(mine.title).toBe("Server");
});

it("reads without a subscription when the store asks for none", async () => {
  const phone = client(server({ show: [{ id: "s1", title: "A" }] }));
  const home = await page(phone);
  const store = home.shows([], { subscribe: false });
  retain(store);
  await vi.advanceTimersByTimeAsync(1);
  expect(phone.resync.mock.calls[0]![0][0]).toMatchObject({ subscribe: false });
  expect(phone.pushed()).toEqual([]);
  expect(store.snapshot()).toMatchObject({ status: "ready", items: [{ id: "s1", title: "A" }] });
});
