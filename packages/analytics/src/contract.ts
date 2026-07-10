/**
 * @parcae/analytics — Contract base class
 *
 * Page-shaped read endpoints. The frontend hits a single URL and gets
 * back a typed JSON object that contains everything the visible
 * surface needs — KPI tiles, trend series, breakdowns, drill-down
 * patient lists. No `useQuery(MetricResult.where(...))` on the page.
 *
 * `mount()` registers a Polka route via `route.get`. Subclasses
 * override `data()` to return the typed payload. `freshness` is
 * computed from the most recent `analytics_snapshot.computedAt` for
 * the metrics that contributed.
 *
 * ```ts
 * class ClinicDashboardContract extends Contract<DashboardPayload> {
 *   path = "/v1/analytics/clinic-dashboard";
 *   metrics = ["engagement.wau", "behaviour.coverage_meal", ...];
 *
 *   async data({ org, period, db }: ContractContext) {
 *     return { kpis: ..., trends: ..., breakdowns: ... };
 *   }
 * }
 *
 * new ClinicDashboardContract().mount();
 * ```
 */

import type { Knex } from "knex";
import { log } from "@parcae/backend";
import type { Period } from "./period.js";

/**
 * Duck-typed Polka shape — we only ever call `.get(path, handler)`.
 * Defined locally so this package doesn't depend on @types/polka,
 * which doesn't exist as a published types package.
 */
export interface PolkaLike {
  get(path: string, handler: (req: unknown, res: unknown) => void): void;
}
import {
  ANALYTICS_SNAPSHOT_TABLE,
} from "./schema.js";

export interface ContractRequest {
  query: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  // Auth context — Parcae's auth middleware sets these. Loosely typed here
  // so this package doesn't depend on a specific auth adapter.
  session?: {
    user?: { id: string; orgId?: string; role?: string } | null;
    orgId?: string;
  };
}

export interface ContractContext {
  org: string;
  period: Period;
  db: Knex;
  now: Date;
  req: ContractRequest;
}

export interface ContractResponse<T> {
  data: T;
  freshness: {
    /** Most recent `computedAt` across the contributing metrics. */
    asOf: Date | null;
    /** Per-metric `computedAt` when callers want a finer view. */
    byMetric: Record<string, Date | null>;
  };
}

export type ContractGuard = (
  req: ContractRequest,
) => string | { error: string; status?: number };

export type ContractOrgAuthorizer = (
  req: ContractRequest,
  requestedOrg: string,
) => boolean | Promise<boolean>;

export abstract class Contract<T = unknown> {
  abstract readonly path: string;
  /**
   * Metric keys the contract reads. The runtime computes freshness from
   * the latest `computedAt` across these. Optional — leave empty when
   * the contract reads non-metric sources only (matviews, raw rows).
   */
  readonly metrics: string[] = [];

  /**
   * Produce the typed payload. The runtime adds freshness on top.
   */
  abstract data(ctx: ContractContext): Promise<T>;

  /**
   * Resolve org + period from the request. Override to change query
   * shape. Default reads `?org=&period=` and falls back to session.
   */
  async resolveContext(
    req: ContractRequest,
    db: Knex,
    parsePeriod: (spec: string) => Period,
  ): Promise<ContractContext> {
    const sessionOrg = req.session?.orgId ?? req.session?.user?.orgId;
    const requestedOrg = pickString(req.query.org);
    const org = requestedOrg ?? sessionOrg;
    if (!org) {
      throw new ContractError(400, "missing org");
    }
    const periodSpec = pickString(req.query.period) ?? "28d";
    const period = parsePeriod(periodSpec);
    return { org, period, db, now: new Date(), req };
  }

  /**
   * Compute freshness for the contract's metrics.
   */
  async freshness(
    ctx: ContractContext,
  ): Promise<ContractResponse<T>["freshness"]> {
    if (this.metrics.length === 0) {
      return { asOf: null, byMetric: {} };
    }
    const rows = await ctx.db(ANALYTICS_SNAPSHOT_TABLE)
      .where("org", ctx.org)
      .whereIn("metricKey", this.metrics)
      .select("metricKey")
      .max({ computedAt: "computedAt" })
      .groupBy("metricKey");
    const byMetric: Record<string, Date | null> = {};
    for (const k of this.metrics) byMetric[k] = null;
    let asOf: Date | null = null;
    for (const r of rows as Array<{ metricKey: string; computedAt: Date | null }>) {
      byMetric[r.metricKey] = r.computedAt;
      if (r.computedAt && (!asOf || r.computedAt > asOf)) asOf = r.computedAt;
    }
    return { asOf, byMetric };
  }
}

export class ContractError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface MountOptions {
  db: Knex;
  parsePeriod: (spec: string) => Period;
  /** Optional auth gate — return user-facing error string to deny. */
  guard?: ContractGuard;
  /** Required to authorize a query org that differs from the session org. */
  authorizeOrg?: ContractOrgAuthorizer;
  /** Optional logger override. Defaults to @parcae/backend's logger. */
  logger?: { error(message: string, error: unknown): void };
}

/**
 * Wire a contract into a Polka instance. Kept as a free function (not
 * a method) so consumers can mount contracts under their own router /
 * middleware stack rather than inheriting Parcae's. The Freia API
 * mounts contracts under its own auth middleware in P1.
 */
export function mountContract<T>(
  app: PolkaLike,
  contract: Contract<T>,
  opts: MountOptions,
): void {
  app.get(contract.path, async (rawReq: unknown, rawRes: unknown) => {
    const req = rawReq as {
      query?: Record<string, string | string[] | undefined>;
      params?: Record<string, string>;
      session?: ContractRequest["session"];
    };
    const res = rawRes as {
      statusCode: number;
      setHeader: (k: string, v: string) => void;
      end: (b: string) => void;
    };
    try {
      const guardErr = opts.guard?.({
        query: req.query ?? {},
        params: req.params ?? {},
        session: req.session,
      });
      if (typeof guardErr === "string") {
        return respond(res, 403, { error: guardErr });
      }
      if (guardErr && typeof guardErr === "object") {
        return respond(res, guardErr.status ?? 403, { error: guardErr.error });
      }

      const reqShape: ContractRequest = {
        query: req.query ?? {},
        params: req.params ?? {},
        session: req.session,
      };
      const ctx = await contract.resolveContext(
        reqShape,
        opts.db,
        opts.parsePeriod,
      );
      await authorizeContext(reqShape, ctx.org, opts.authorizeOrg);
      const [data, freshness] = await Promise.all([
        contract.data(ctx),
        contract.freshness(ctx),
      ]);
      respond(res, 200, { data, freshness } satisfies ContractResponse<T>);
    } catch (err) {
      if (err instanceof ContractError) {
        return respond(res, err.status, { error: err.message });
      }
      if (opts.logger) {
        opts.logger.error(`[analytics] ${contract.path} failed`, err);
      } else {
        log.error(`[analytics] ${contract.path} failed:`, err);
      }
      respond(res, 500, { error: "internal error" });
    }
  });
}

async function authorizeContext(
  req: ContractRequest,
  org: string,
  authorizeOrg?: ContractOrgAuthorizer,
): Promise<void> {
  const sessionOrg = req.session?.orgId ?? req.session?.user?.orgId;
  if (org !== sessionOrg && (!authorizeOrg || !(await authorizeOrg(req, org)))) {
    throw new ContractError(403, "forbidden org");
  }
}

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function respond(
  res: {
    statusCode: number;
    setHeader: (k: string, v: string) => void;
    end: (b: string) => void;
  },
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
