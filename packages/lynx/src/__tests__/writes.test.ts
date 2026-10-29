/**
 * A kept change: shown at once, stored, sent with its key until an answer with a status settles it,
 * and put back on a refusal.
 */

import { Model, type PatchOp } from "@parcae/model";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { keep, refusalOf } from "../writes";
import { provideClient } from "../client-registry";
import { createLiveQuery, resetLiveQueries, type QueryChain } from "../live-query";
import { provideRowStorage, type RowStorage, type StoredWrite } from "../rows";

class Show extends Model {
  static type = "show" as const;
  title = "";
}

const adapter = {} as any;
const read = (): QueryChain<Show> => ({
  find: async () => {
    const sent = [{ id: "s1", title: "Night Shift" }];
    const models = sent.map((row) => Show.hydrate(adapter, structuredClone(row)));
    Object.defineProperty(models, "__rows", { value: sent });
    return models;
  },
  __modelClass: Show,
  __adapter: adapter,
  __modelType: "show",
  __steps: [],
});

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
const moments: unknown[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  provideClient(
    () =>
      ({
        subscribe              : () => () => {},
        withQuerySubscriptions : (run: () => Promise<unknown>) => run(),
        session                : { state: { status: "authenticated", userId: "u1" } },
        isConnected            : true,
        adapter                : { resolvePath: () => "/shows" },
        patch,
        delete                 : remove,
        _emitDiagnostic        : (event: string, moment: unknown) => event === "write" && moments.push(moment),
      }) as never,
  );
  provideRowStorage(storage);
  resetLiveQueries(true, "u1");
});

afterEach(() => {
  kept.length = 0;
  provideRowStorage(null);
  vi.useRealTimers();
});

it("shows a kept patch at once, resends it with its key after a lost line, and puts a refusal back", async () => {
  patch
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValueOnce({ id: "s1", title: "Renamed" })
    .mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
  const store = createLiveQuery(read);
  const release = store.retain(() => {});
  await vi.advanceTimersByTimeAsync(0);
  const show = store.snapshot().items[0]!;

  const rename: PatchOp[] = [{ op: "replace", path: "/title", value: "Renamed" }];
  await keep(show).patch(rename);
  expect(show.title).toBe("Renamed");
  const [{ key }] = kept as [StoredWrite];
  await vi.advanceTimersByTimeAsync(0);
  expect(patch).toHaveBeenLastCalledWith("/shows/s1", { ops: rename }, { idempotencyKey: key });
  expect(kept).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(1_000);
  expect(patch).toHaveBeenCalledTimes(2);
  expect(patch).toHaveBeenLastCalledWith("/shows/s1", { ops: rename }, { idempotencyKey: key });
  expect(kept).toHaveLength(0);
  expect(show.title).toBe("Renamed");

  await keep(show).patch([{ op: "replace", path: "/title", value: "Other" }]);
  expect(show.title).toBe("Other");
  await vi.advanceTimersByTimeAsync(0);
  expect(show.title).toBe("Renamed");
  expect(refusalOf(show)).toMatchObject({ method: "PATCH", status: 403 });
  expect(moments.at(-1)).toMatchObject({ moment: "refused", status: 403 });
  expect(kept).toHaveLength(0);
  expect(moments.map((m) => (m as { moment: string }).moment)).toEqual(["retried", "sent", "refused"]);
  release();
});

it("keeps a waiting delete laid over the page when the same account's session settles again", async () => {
  remove.mockRejectedValue(new Error("Disconnected"));
  const store = createLiveQuery(read);
  const release = store.retain(() => {});
  await vi.advanceTimersByTimeAsync(0);
  await keep(store.snapshot().items[0]!).remove();
  expect(store.snapshot().items).toHaveLength(0);

  resetLiveQueries(false);
  resetLiveQueries(true, "u1");
  await vi.advanceTimersByTimeAsync(0);
  expect(kept).toHaveLength(1);
  expect(store.snapshot().items).toHaveLength(0);
  release();
});
