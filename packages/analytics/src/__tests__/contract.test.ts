import { describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";
import {
  Contract,
  mountContract,
  type ContractContext,
  type ContractRequest,
  type PolkaLike,
} from "../contract.js";
import { Period } from "../period.js";

class OrgContract extends Contract<{ org: string }> {
  readonly path = "/analytics";

  async data(ctx: ContractContext) {
    return { org: ctx.org };
  }
}

describe("mountContract", () => {
  it("uses the authenticated session org", async () => {
    const mounted = mount();
    const response = createResponse();

    await mounted.handler({
      query: {},
      session: { user: { id: "user", orgId: "org-session" } },
    }, response.res);

    expect(response.status()).toBe(200);
    expect(response.json()).toMatchObject({ data: { org: "org-session" } });
  });

  it("rejects query org overrides without explicit authorization", async () => {
    const mounted = mount();
    const response = createResponse();

    await mounted.handler({
      query: { org: "org-other" },
      session: { orgId: "org-session" },
    }, response.res);

    expect(response.status()).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden org" });
  });

  it("allows an org override only through the authorization callback", async () => {
    const authorizeOrg = vi.fn().mockResolvedValue(true);
    const mounted = mount({ authorizeOrg });
    const response = createResponse();

    await mounted.handler({
      query: { org: "org-other" },
      session: { orgId: "org-session" },
    }, response.res);

    expect(authorizeOrg).toHaveBeenCalledTimes(1);
    expect(authorizeOrg).toHaveBeenCalledWith(expect.any(Object), "org-other");
    expect(response.json()).toMatchObject({ data: { org: "org-other" } });
  });

  it("authorizes the final org returned by a resolveContext override", async () => {
    const authorizeOrg = vi.fn().mockResolvedValue(false);
    const mounted = mount({
      authorizeOrg,
      contract: new class extends OrgContract {
        async resolveContext(req: ContractRequest, db: Knex) {
          return {
            org: "org-bypassed",
            period: Period.last("7d"),
            db,
            now: new Date(),
            req,
          };
        }
      }(),
    });
    const response = createResponse();

    await mounted.handler({
      query: {},
      session: { orgId: "org-session" },
    }, response.res);

    expect(authorizeOrg).toHaveBeenCalledTimes(1);
    expect(authorizeOrg).toHaveBeenCalledWith(
      expect.any(Object),
      "org-bypassed",
    );
    expect(response.status()).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden org" });
  });

  it("logs internal errors and returns a generic 500", async () => {
    const logger = { error: vi.fn() };
    const mounted = mount({
      logger,
      contract: new class extends OrgContract {
        async data(): Promise<{ org: string }> {
          throw new Error("database credentials leaked");
        }
      }(),
    });
    const response = createResponse();

    await mounted.handler({
      query: {},
      session: { orgId: "org-session" },
    }, response.res);

    expect(logger.error).toHaveBeenCalled();
    expect(response.status()).toBe(500);
    expect(response.json()).toEqual({ error: "internal error" });
  });
});

function mount(options: {
  authorizeOrg?: (req: ContractRequest, org: string) => boolean | Promise<boolean>;
  logger?: { error(message: string, error: unknown): void };
  contract?: Contract<{ org: string }>;
} = {}) {
  let handler!: (req: unknown, res: unknown) => Promise<void>;
  const app: PolkaLike = {
    get(_path, next) {
      handler = next as typeof handler;
    },
  };
  mountContract(app, options.contract ?? new OrgContract(), {
    db: (() => {
      throw new Error("freshness should not query without metrics");
    }) as unknown as Knex,
    parsePeriod: (spec) => Period.last(spec as "7d" | "28d"),
    authorizeOrg: options.authorizeOrg,
    logger: options.logger,
  });
  return { handler };
}

function createResponse() {
  let status = 0;
  let body = "";
  return {
    res: {
      setHeader() {},
      end(nextBody: string) {
        body = nextBody;
      },
      set statusCode(value: number) {
        status = value;
      },
      get statusCode() {
        return status;
      },
    },
    status: () => status,
    json: () => JSON.parse(body) as unknown,
  };
}
