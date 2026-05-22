/**
 * RefLoader — request-scoped batcher for reference proxy resolution.
 *
 * BackendAdapter's `findById` is called once per ref access (`post.user`,
 * `comment.author`, etc.). On a LIST endpoint that returns 100 posts
 * each with a `user` ref, the naive path issues 100 separate
 * `SELECT * WHERE id = ?` queries — classic N+1.
 *
 * `RefLoader.load(type, id)` defers the actual fetch to the next
 * microtask. Every `load()` call within the same tick lands in one
 * batch. The batch is then split by `type`, deduplicated by id, and
 * one `loadByIds(type, ids)` is issued per type. Each load() promise
 * resolves with the matching row from that batch's result map.
 *
 * The loader is request-scoped — `app.ts` creates one per inbound
 * request and stows it on `RequestContext.refLoader` via the
 * `AsyncLocalStorage` in `services/context.ts`. `BackendAdapter`
 * consults the context loader inside `findById` and falls through to
 * the direct query when no loader is active (background jobs, hook
 * paths outside a request, tests).
 *
 * Errors thrown by `loadByIds` are propagated to every queued caller
 * for that type's slice of the batch. Other types' slices in the same
 * tick are isolated — one bad type doesn't poison the rest.
 *
 * The loader is DataLoader-style without the dependency; the surface
 * we need is small enough that a 50-line homegrown implementation
 * beats pulling in `dataloader` plus its peer-dep handling for one
 * use case.
 */

interface Entry {
  type: string;
  id: string;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

/**
 * Callback that takes a model `type` (e.g. `"user"`) and a list of
 * unique ids, and returns a `Map<id, row>` of matching rows. Missing
 * ids are simply omitted from the map; `load()` returns `null` for
 * any id absent from the result.
 */
export type BatchLoad = (
  type: string,
  ids: string[],
) => Promise<Map<string, unknown>>;

export class RefLoader {
  private queue: Entry[] = [];
  private scheduled = false;
  private readonly loadByIds: BatchLoad;

  constructor(loadByIds: BatchLoad) {
    this.loadByIds = loadByIds;
  }

  /**
   * Enqueue a lookup. Resolves with the matching row (whatever shape
   * `loadByIds` returns in its map values) or `null` when the row
   * doesn't exist.
   *
   * Falsy `id`s short-circuit to `null` without scheduling a batch —
   * keeps the call site free of "is this ref attached?" branches.
   */
  load(type: string, id: string | null | undefined): Promise<unknown> {
    if (!id) return Promise.resolve(null);
    return new Promise<unknown>((resolve, reject) => {
      this.queue.push({ type, id, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => this._flush());
      }
    });
  }

  private async _flush(): Promise<void> {
    const batch = this.queue;
    this.queue = [];
    this.scheduled = false;
    if (batch.length === 0) return;

    // Bucket entries by type so we can issue one loadByIds call per
    // distinct type. Order within a type doesn't matter — the result
    // is a Map keyed by id.
    const byType = new Map<string, Entry[]>();
    for (const entry of batch) {
      let arr = byType.get(entry.type);
      if (!arr) {
        arr = [];
        byType.set(entry.type, arr);
      }
      arr.push(entry);
    }

    // Each per-type fetch is independent. We fan out with allSettled
    // so a thrown loadByIds for one type rejects only its own
    // entries; other types' callers still get their data.
    await Promise.all(
      Array.from(byType.entries()).map(async ([type, entries]) => {
        const uniqueIds = Array.from(new Set(entries.map((e) => e.id)));
        try {
          const rows = await this.loadByIds(type, uniqueIds);
          for (const entry of entries) {
            entry.resolve(rows.get(entry.id) ?? null);
          }
        } catch (err) {
          for (const entry of entries) entry.reject(err);
        }
      }),
    );
  }
}
