/**
 * A kept change: shown at once, stored, sent with its key until an answer with a status settles it,
 * put back on a refusal, and landed or dropped on every other page as the engine says.
 */

import type { PatchOp } from "@parcae/model";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { RowStorage, StoredWrite } from "../rows";
import { page, reset, client, server, retain } from "./harness";

const kept: StoredWrite[] = [];
const storage: RowStorage = {
  read: async () => ({ user: "u1", list: null, rows: [] }),
  write: async ({ writes = [], settled = [] }) => {
    for (const write of writes) {
      const at = kept.findIndex((k) => k.key === write.key);
      if (at < 0) kept.push(write);
      else kept[at] = write;
    }
    for (const key of settled) kept.splice(kept.findIndex((k) => k.key === key), 1);
  },
  waiting: async () => ({ user: "u1", writes: [...kept] }),
};
const patch = vi.fn();
const remove = vi.fn();
const rename = (value: string): PatchOp[] => [{ op: "replace", path: "/title", value }];

function line() {
  return client(server({ show: [{ id: "s1", title: "Night Shift" }] }), { patch, delete: remove });
}

beforeEach(() => {
  vi.useFakeTimers();
  reset();
  patch.mockReset();
  remove.mockReset();
});

afterEach(() => {
  kept.length = 0;
  vi.useRealTimers();
});

it("shows a kept patch at once, resends it with its key after a lost line, and puts a refusal back", async () => {
  patch
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValueOnce({ id: "s1", title: "Renamed" })
    .mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
  const phone = line();
  const home = await page(phone, storage);
  const store = home.shows();
  retain(store);
  await vi.advanceTimersByTimeAsync(1);
  const show = store.snapshot().items[0]!;

  await home.lynx.keep(show).patch(rename("Renamed"));
  expect(show.title).toBe("Renamed");
  const [{ key }] = kept as [StoredWrite];
  await vi.advanceTimersByTimeAsync(1);
  expect(patch).toHaveBeenLastCalledWith("/shows/s1", { ops: rename("Renamed") }, { idempotencyKey: key });
  expect(kept).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(1_000);
  expect(patch).toHaveBeenCalledTimes(2);
  expect(patch).toHaveBeenLastCalledWith("/shows/s1", { ops: rename("Renamed") }, { idempotencyKey: key });
  expect(kept).toHaveLength(0);
  expect(show.title).toBe("Renamed");

  await home.lynx.keep(show).patch(rename("Other"));
  expect(show.title).toBe("Other");
  await vi.advanceTimersByTimeAsync(1);
  expect(show.title).toBe("Renamed");
  expect(home.lynx.refusalOf(show)).toMatchObject({ method: "PATCH", status: 403 });
  expect(kept).toHaveLength(0);
  const moments = phone.diagnostics.filter(([event]) => event === "write").map(([, moment]) => (moment as { moment: string }).moment);
  expect(moments).toEqual(["retried", "sent", "refused"]);
});

it("keeps a change made offline before the server knows the account, and sends it once signed in", async () => {
  remove.mockResolvedValue(null);
  const phone = line();
  const home = await page(phone, storage);
  const store = home.shows();
  retain(store);
  await vi.advanceTimersByTimeAsync(1);
  const show = store.snapshot().items[0]!;
  phone.isConnected = false;
  phone.settle("pending", null);

  await home.lynx.keep(show).remove();
  expect(kept).toHaveLength(1);
  expect(remove).not.toHaveBeenCalled();

  phone.isConnected = true;
  phone.settle("authenticated", "u1");
  await vi.advanceTimersByTimeAsync(1);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenLastCalledWith("/shows/s1", {}, { idempotencyKey: expect.any(String) });
  expect(kept).toHaveLength(0);
});

it("shows another page's patch while it waits, lands it there on its answer, and takes back a refusal", async () => {
  patch.mockResolvedValueOnce({ id: "s1", title: "Renamed" }).mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
  const phone = line();
  const home = await page(phone, storage);
  const list = home.shows();
  retain(list);
  const create = await page(phone, storage);
  const show = create.shows();
  retain(show);
  await vi.advanceTimersByTimeAsync(1);
  const listed = list.snapshot().items[0]!;

  const kept = create.lynx.keep(show.snapshot().items[0]!).patch(rename("Renamed"));
  expect(listed.title).toBe("Renamed");
  await kept;
  await vi.advanceTimersByTimeAsync(1);
  expect(listed.title).toBe("Renamed");

  await create.lynx.keep(show.snapshot().items[0]!).patch(rename("Other"));
  expect(listed.title).toBe("Other");
  await vi.advanceTimersByTimeAsync(1);
  expect(listed.title).toBe("Renamed");
  expect(home.lynx.refusalOf(listed)).toBeNull();
});
