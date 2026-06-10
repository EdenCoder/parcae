/**
 * Client-query orchestration — the canonical pipeline for "client
 * `__query` steps → either a subscribed result with expand or a raw
 * query."
 *
 * Three helpers, each owning a discrete slice of the work:
 *
 *   prepareClientQuery({ ModelClass, scopeResult, rawSteps, ... })
 *     → { query, countQuery, expandResolved, steps }
 *
 *   runQuerySubscription({ ...prep, socketId, user, force? })
 *     → { items, hash, totalCount }
 *
 *   runQueryStatic({ ...prep, user })
 *     → { items, totalCount }
 *
 * `prepareClientQuery` is pure step-manipulation + query construction —
 * no I/O, no subscription side effects. It normalises raw steps, peels
 * off `.expand(...)`, strips expand from the SQL replay, and builds the
 * count companion. Four call sites use it: the LIST handler's
 * count-short-circuit, the LIST handler's static and subscribed fetch
 * paths, and the socket-RPC resync handler.
 *
 * `runQuerySubscription` consumes a prep result, runs the subscribe +
 * hydrate handshake against `adapter.subscriptions`, and returns the
 * wire-ready row set. Two call sites use it: the LIST handler (when
 * `req._socketId` is set AND the request didn't opt out via
 * `__subscribe: false`) and the socket-RPC `resync` handler (for
 * dynamic entries).
 *
 * `runQueryStatic` mirrors `runQuerySubscription` for the static
 * path — plain find + sanitise + expand hydrate, no subscription
 * registered. Used by the LIST handler when `__subscribe: false`
 * (set by `useQuery({ subscribe: false })` / `prefetch(...,
 * { subscribe: false })`), the LIST handler's non-socket fallback,
 * and the socket-RPC `resync` handler for static entries on
 * reconnect.
 *
 * Before this consolidation, the LIST handler's non-socket path and
 * the resync handler's pipeline each had their own diverged copies of
 * the subscribe path. The resync copy skipped `parseExpandSpecs`,
 * `validateExpandSpecs`, `stripExpandSteps`, `expand:` on `subscribe`,
 * and `hydrateExpansions` entirely — which meant every WebSocket
 * reconnect served un-expanded rows to clients that had originally
 * requested `.expand("file")`. The editor's `useAssetFile` snapped to
 * `null` on every reconnect until a manual refetch. See DOL-1095.
 */

import type { ModelConstructor, QueryChain } from "@parcae/model";
import { extractExpandFields, stripExpandSteps } from "@parcae/model";
import type { BackendAdapter } from "../adapters/model";
import { getRefLoader } from "./context";
import {
  hydrateExpansions,
  parseExpandSpecs,
  validateExpandSpecs,
  type ResolvedExpand,
} from "./hydrate-expansions";

// ─── prepareClientQuery ──────────────────────────────────────────────────────

export interface PrepareClientQueryOptions {
  /** Model whose `scope.read` already gated the caller. */
  ModelClass: ModelConstructor;
  /** Predicate returned by `ModelClass.scope.read(ctx)`. */
  scopeResult: Record<string, any>;
  /** Raw `__query` payload from the client — array or JSON string. */
  rawSteps: unknown;
  /**
   * Type → constructor index built once per route registration / app
   * boot. `validateExpandSpecs` needs it to resolve a ref target
   * without coupling to BackendAdapter internals.
   */
  modelByType: Map<string, ModelConstructor>;
  adapter: BackendAdapter;
}

export interface PreparedClientQuery {
  /** SQL-replayable chain — expand steps stripped. */
  query: QueryChain<any>;
  /** Parallel count chain — expand + limit/offset steps stripped. */
  countQuery: QueryChain<any>;
  /** Resolved expand projections, frozen by `validateExpandSpecs`. */
  expandResolved: readonly ResolvedExpand[];
  /** Normalised, expand-stripped step array — exposed for callers
   *  that want to introspect the SQL-side step list. */
  steps: any[];
}

/**
 * Normalise the wire shape. `__query` arrives either as an Array (the
 * socket-RPC path) or as a JSON-encoded string (HTTP query string).
 */
function normaliseSteps(rawSteps: unknown): any[] {
  if (Array.isArray(rawSteps)) return rawSteps;
  if (typeof rawSteps !== "string") return [];
  try {
    const parsed = JSON.parse(rawSteps);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function prepareClientQuery(
  opts: PrepareClientQueryOptions,
): PreparedClientQuery {
  const { ModelClass, scopeResult, rawSteps, modelByType, adapter } = opts;

  const normalised = normaliseSteps(rawSteps);

  // Peel `.expand(...)` projections off the recorded steps before SQL
  // replay. Expand is a wire-shape directive, not a SQL operation;
  // callers apply it after the row set lands (via `RefLoader` for
  // immediate responses; via the subscription manager's per-emit
  // hydrate for ongoing diffs).
  const expandSpecs = parseExpandSpecs(extractExpandFields(normalised));
  const expandResolved = validateExpandSpecs(
    expandSpecs,
    ModelClass,
    modelByType,
  );
  const steps =
    expandResolved.length > 0 ? stripExpandSteps(normalised) : normalised;

  const query = adapter.queryFromClient(ModelClass, scopeResult, steps);

  // Parallel count query — same filters, no limit/offset — so clients
  // can render the full result-set size, not the current page size.
  const stepsWithoutPagination = steps.filter(
    (s: any) => s?.method !== "limit" && s?.method !== "offset",
  );
  const countQuery = adapter.queryFromClient(
    ModelClass,
    scopeResult,
    stepsWithoutPagination,
  );

  return { query, countQuery, expandResolved, steps };
}

// ─── runQuerySubscription ────────────────────────────────────────────────────

export interface RunQuerySubscriptionOptions {
  /** Output of `prepareClientQuery` — the chains + resolved expand. */
  prep: PreparedClientQuery;
  /** Socket id the subscription is bound to. */
  socketId: string;
  /** Request user — passed to `hydrateExpansions` for `sanitize()`. */
  user: { id: string } | null;
  adapter: BackendAdapter;
  /**
   * Force the subscription cache to re-execute against the DB. The
   * HTTP LIST handler sets this for `__forceRefresh: true` drift-poll
   * requests; resync leaves it unset so the cached row set serves the
   * first reconnect ack.
   */
  force?: boolean;
}

export interface RunQuerySubscriptionResult {
  /** Sanitised, expand-hydrated rows ready to ship to the client. */
  items: any[];
  /** Subscription cache hash — the client subscribes to `query:${hash}`. */
  hash: string;
  /** Filter-matched row count without limit/offset, for pagination UI. */
  totalCount: number;
}

export async function runQuerySubscription(
  opts: RunQuerySubscriptionOptions,
): Promise<RunQuerySubscriptionResult> {
  const { prep, socketId, user, adapter, force = false } = opts;

  if (!adapter.subscriptions) {
    throw new Error(
      "runQuerySubscription: BackendAdapter has no subscription manager — " +
        "either call the helper from a socket-aware path only, or attach " +
        "QuerySubscriptionManager via adapter.subscriptions.",
    );
  }

  const { query, countQuery, expandResolved, steps } = prep;

  const [sub, totalCount] = await Promise.all([
    adapter.subscriptions.subscribe(
      { socketId, query, expand: expandResolved, steps },
      { force },
    ),
    countQuery.count(),
  ]);

  // Subscription items come pre-sanitised from `_execQuery`. Hydrate
  // the request-side expansions for the immediate response; the
  // manager handles the ongoing delta emissions itself, keyed on the
  // same `expandResolved` spec.
  const items = [...sub.items];
  if (expandResolved.length > 0) {
    const loader = getRefLoader();
    if (loader) {
      await hydrateExpansions(items, expandResolved, loader, user);
    }
    // No RefLoader → rows go out un-expanded. Only happens for code
    // paths that bypass `runWithRequestContext`; the HTTP LIST path
    // and the socket-RPC `resync` handler both install one.
  }

  return { items, hash: sub.hash, totalCount };
}

// ─── runQueryStatic ──────────────────────────────────────────────────────────

export interface RunQueryStaticOptions {
  /** Output of `prepareClientQuery` — the chains + resolved expand. */
  prep: PreparedClientQuery;
  /** Request user — passed to model `sanitize()` and `hydrateExpansions`. */
  user: { id: string } | null;
  adapter: BackendAdapter;
}

export interface RunQueryStaticResult {
  /** Sanitised, expand-hydrated rows ready to ship to the client. */
  items: any[];
  /** Filter-matched row count without limit/offset, for pagination UI. */
  totalCount: number;
}

/**
 * Run the static (no-subscription) pipeline: plain find + sanitise +
 * expand hydrate, no `QuerySubscriptionManager` registration, no
 * `__queryHash` produced. The LIST handler uses this for the
 * non-socket fallback and for `__subscribe: false` requests; the
 * socket-RPC resync handler uses it for entries the client marked
 * static.
 */
export async function runQueryStatic(
  opts: RunQueryStaticOptions,
): Promise<RunQueryStaticResult> {
  const { prep, user } = opts;
  const { query, countQuery, expandResolved } = prep;

  const [rawItems, totalCount] = await Promise.all([
    query.find(),
    countQuery.count(),
  ]);

  // Sanitise to wire shape — mirrors routes.ts's `projectForWire`.
  // Models that ship a `sanitize(user)` method honour their declared
  // privateFields; the fallback covers test fixtures and oddball
  // model implementations that don't define sanitize.
  const items = await Promise.all(
    rawItems.map(async (m: any) => {
      if (typeof m?.sanitize === "function") {
        return await m.sanitize(user ?? undefined);
      }
      return m?.__data ?? m;
    }),
  );

  if (expandResolved.length > 0) {
    const loader = getRefLoader();
    if (loader) {
      await hydrateExpansions(items, expandResolved, loader, user);
    }
    // No RefLoader → rows go out un-expanded. Mirrors
    // `runQuerySubscription`'s behaviour — only happens for paths
    // that bypass `runWithRequestContext`.
  }

  return { items, totalCount };
}
