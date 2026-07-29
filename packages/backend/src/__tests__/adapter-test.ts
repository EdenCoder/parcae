/**
 * Recording `BackendAdapter` stand-in shared by the query-building
 * tests.
 *
 * Not a `.test.ts` file, so `vitest.config.ts` (which collects only
 * `src/__tests__/** /*.test.ts`) skips it — same arrangement as
 * `postgres-test.ts`.
 *
 * The chain is a Proxy that stubs the terminal methods and records
 * every other call, so a test can assert on exactly what
 * `queryFromClient` built without a database.
 *
 * One option needs explaining: `invoke`, which controls whether the
 * fake builder RUNS the callbacks handed to `where(fn)` or just files
 * them. Both behaviours are load-bearing and neither is more correct —
 * `queryFromClient` groups its predicates into a single
 * `where((builder) => …)`, and a `__nested` step becomes a second
 * callback one level down.
 *
 *   "never"  the callback is recorded with its function argument
 *            intact, so a test can invoke it later against its own
 *            instrumented builder and inspect the replay
 *   "root"   the outer grouping callback runs, so the predicates
 *            inside it get recorded as ordinary calls
 *   "all"    callbacks run at every depth, as knex does when it
 *            materialises SQL — `__nested` args only validate when
 *            their callback is invoked, so this is the only setting
 *            under which a nested step is actually exercised
 */

import { BackendAdapter } from "../adapters/model";
import type { ModelConstructor, SchemaDefinition } from "@parcae/model";

export interface RecordedCall {
  method: string;
  args: any[];
}

/** How deep the fake builder auto-invokes `where(fn)` callbacks. */
export type InvokeDepth = "never" | "root" | "all";

export interface TestAdapterOptions {
  /** Callback-invocation depth. Default `"never"`. */
  invoke?: InvokeDepth;
  /**
   * Non-method properties the chain answers with a value rather than a
   * recording function (e.g. the `__steps` / `__modelType` accessors
   * the search path reads).
   */
  props?: Record<string, unknown>;
  /**
   * Leave `adapter.query()` as the real implementation so the
   * server-side query path is exercised end to end. `read`/`write`
   * still return the recording chain, so calls are captured either
   * way. Default `false` — `query()` is stubbed to the chain.
   */
  realQuery?: boolean;
}

export interface TestAdapter {
  adapter: BackendAdapter;
  /** Every recorded call, in order, shared across all chain instances. */
  calls: RecordedCall[];
}

/** Minimal model stand-in — `type` + `__schema` is all the query path reads. */
export function createMockModel(
  type: string,
  schema: SchemaDefinition,
  extra: Record<string, unknown> = {},
): any {
  return { type, __schema: schema, ...extra };
}

export function createTestAdapter(
  options: TestAdapterOptions = {},
): TestAdapter {
  const { invoke = "never", props = {}, realQuery = false } = options;
  const calls: RecordedCall[] = [];

  function make(isRoot = true): any {
    return new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === "find") return async () => [];
          if (prop === "first") return async () => null;
          if (prop === "count") return async () => 0;
          if (prop === "exec") return () => ({});
          if (prop === "clone") return () => make(isRoot);
          // Never a thenable — an awaited chain must not resolve
          // through the Proxy's catch-all.
          if (prop === "then") return undefined;
          if (prop in props) return props[prop];
          return (...args: any[]) => {
            const runs =
              prop === "where" &&
              typeof args[0] === "function" &&
              (invoke === "all" || (invoke === "root" && isRoot));
            if (runs) {
              args[0](make(false));
              return make(isRoot);
            }
            calls.push({ method: prop, args });
            return make(isRoot);
          };
        },
      },
    );
  }

  // `read`/`write` are getters over `services`, and the ref-subquery
  // path calls `this.read(table)` — so the chain goes in here. The
  // knex-ish `raw`/`schema` surface rides along because the search
  // path reaches for it.
  const service = () =>
    Object.assign(() => make(), {
      raw: (sql: string, bindings?: any[]) => ({ sql, bindings }),
      schema: {
        hasTable: async () => false,
        hasColumn: async () => false,
      },
    });

  const adapter = new (BackendAdapter as any)({
    read: service(),
    write: service(),
  });
  if (!realQuery) adapter.query = () => make();

  return { adapter: adapter as BackendAdapter, calls };
}

/** Register models so ref targets resolve out of the adapter registry. */
export function registerTestModels(
  adapter: BackendAdapter,
  models: Record<string, ModelConstructor | any>,
): void {
  for (const [type, model] of Object.entries(models)) {
    (adapter as any)._models.set(type, model);
  }
}
