import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import {
  createServer_,
  type AuthSetupContext,
  type Config,
} from "@parcae/backend";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  memberships: vi.fn().mockResolvedValue({ data: [] }),
  verifyToken: vi.fn(),
  verifyWebhook: vi.fn(),
}));

vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    users: {
      getUser: mocks.getUser,
      getOrganizationMembershipList: mocks.memberships,
    },
  }),
  verifyToken: mocks.verifyToken,
}));

vi.mock("svix", () => ({
  Webhook: class {
    verify = mocks.verifyWebhook;
  },
}));

import { clerk } from "../index.js";

const config = {
  secretKey: "sk_test",
  publishableKey: "pk_test",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberships.mockResolvedValue({ data: [] });
  mocks.verifyToken.mockResolvedValue({ sub: "user_1" });
});

describe("clerk server adapter", () => {
  it("passes authorized parties to Clerk token verification", async () => {
    const ctx = setupContext();
    ctx.rows.set("user_1", { id: "user_1" });
    const authorizedParties = ["https://app.example.com"];
    const auth = clerk({ ...config, authorizedParties });
    await auth.setup(ctx);

    await expect(auth.resolveToken("token")).resolves.toEqual({
      user: { id: "user_1" },
    });
    expect(mocks.verifyToken).toHaveBeenCalledWith("token", {
      secretKey: "sk_test",
      authorizedParties,
    });
  });

  it("reads the org role from the v2 JWT claim without calling the Clerk API", async () => {
    mocks.verifyToken.mockResolvedValue({
      sub: "user_1",
      o: { id: "org_1", rol: "admin", slg: "acme" },
    });
    const ctx = setupContext();
    ctx.rows.set("user_1", { id: "user_1" });
    const auth = clerk(config);
    await auth.setup(ctx);

    await expect(auth.resolveToken("token")).resolves.toEqual({
      user: {
        id: "user_1",
        orgId: "org_1",
        orgRole: "org:admin",
        orgSlug: "acme",
      },
    });
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it("passes an already-prefixed v1 org_role claim through unchanged", async () => {
    mocks.verifyToken.mockResolvedValue({
      sub: "user_1",
      org_id: "org_1",
      org_role: "org:freia_staff",
    });
    const ctx = setupContext();
    ctx.rows.set("user_1", { id: "user_1" });
    const auth = clerk(config);
    await auth.setup(ctx);

    await expect(auth.resolveToken("token")).resolves.toMatchObject({
      user: { orgId: "org_1", orgRole: "org:freia_staff" },
    });
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it("falls back to the Clerk API at max page size when the JWT lacks a role claim", async () => {
    mocks.verifyToken.mockResolvedValue({
      sub: "user_1",
      o: { id: "org_1" },
    });
    mocks.memberships.mockResolvedValue({
      data: [{ organization: { id: "org_1" }, role: "org:clinician" }],
    });
    const ctx = setupContext();
    ctx.rows.set("user_1", { id: "user_1" });
    const auth = clerk(config);
    await auth.setup(ctx);

    await expect(auth.resolveToken("token")).resolves.toMatchObject({
      user: { orgId: "org_1", orgRole: "org:clinician" },
    });
    expect(mocks.memberships).toHaveBeenCalledWith({
      userId: "user_1",
      limit: 500,
    });
  });

  it("denies a session when local provisioning fails", async () => {
    mocks.getUser.mockRejectedValue(new Error("Clerk unavailable"));
    const auth = clerk(config);
    await auth.setup(setupContext());

    await expect(auth.resolveToken("token")).resolves.toBeNull();
  });

  it("deduplicates concurrent local provisioning", async () => {
    let release!: (value: object) => void;
    mocks.getUser.mockReturnValue(new Promise((resolve) => {
      release = resolve;
    }));
    const ctx = setupContext();
    const auth = clerk(config);
    await auth.setup(ctx);

    const first = auth.resolveToken("one");
    const second = auth.resolveToken("two");
    release({
      firstName: "Ada",
      lastName: "Lovelace",
      emailAddresses: [],
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { user: { id: "user_1" } },
      { user: { id: "user_1" } },
    ]);
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(ctx.adapter.save).toHaveBeenCalledTimes(1);
  });

  it("verifies webhooks against req.rawBody", async () => {
    const rawBody = Buffer.from('{"type":"user.deleted"}');
    mocks.verifyWebhook.mockReturnValue({
      type: "user.deleted",
      data: { id: "missing" },
    });
    const auth = clerk({ ...config, webhookSecret: "whsec_test" });
    await auth.setup(setupContext());
    const response = createResponse();

    await auth.routes?.handler({
      body: { changed: true },
      rawBody,
      headers: {
        "svix-id": "id",
        "svix-timestamp": "time",
        "svix-signature": "signature",
      },
    }, response.res);

    expect(mocks.verifyWebhook).toHaveBeenCalledWith(rawBody, expect.any(Object));
    expect(response.status()).toBe(200);
  });

  it("does not authenticate or recreate a user deleted during provisioning", async () => {
    let release!: (value: object) => void;
    mocks.getUser.mockReturnValue(new Promise((resolve) => {
      release = resolve;
    }));
    mocks.verifyWebhook.mockReturnValue({
      type: "user.deleted",
      data: { id: "user_1" },
    });
    const ctx = setupContext();
    const auth = clerk({ ...config, webhookSecret: "whsec_test" });
    await auth.setup(ctx);

    const provision = auth.resolveToken("token");
    await vi.waitFor(() => expect(mocks.getUser).toHaveBeenCalledTimes(1));
    const deletion = auth.routes?.handler({
      rawBody: Buffer.from("{}"),
      headers: {
        "svix-id": "id",
        "svix-timestamp": "time",
        "svix-signature": "signature",
      },
    }, createResponse().res);
    release({ firstName: "Deleted", emailAddresses: [] });

    await expect(provision).resolves.toBeNull();
    await deletion;
    expect(ctx.rows.has("user_1")).toBe(false);
    expect(ctx.adapter.save).not.toHaveBeenCalled();
    expect(ctx.tombstones.has("user_1")).toBe(true);
  });

  it("receives the exact raw body through the backend JSON middleware", async () => {
    const rawBody = '{\n  "type": "user.deleted",\n  "data": { "id": "missing" }\n}';
    mocks.verifyWebhook.mockReturnValue({
      type: "user.deleted",
      data: { id: "missing" },
    });
    const auth = clerk({ ...config, webhookSecret: "whsec_test" });
    await auth.setup(setupContext());
    const server = createServer_({ config: {} as Config, version: "test" });
    server.polka.all(
      `${auth.routes!.basePath}/*`,
      auth.routes!.handler,
    );

    await new Promise<void>((resolve, reject) => {
      server.httpServer.once("error", reject);
      server.httpServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.httpServer.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/webhooks/clerk/events`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "svix-id": "id",
            "svix-timestamp": "time",
            "svix-signature": "signature",
          },
          body: rawBody,
        },
      );

      expect(response.status).toBe(200);
      expect(mocks.verifyWebhook).toHaveBeenCalledWith(
        Buffer.from(rawBody),
        expect.any(Object),
      );
    } finally {
      await new Promise<void>((resolve) => server.io.close(() => resolve()));
      if (server.httpServer.listening) {
        await new Promise<void>((resolve, reject) => {
          server.httpServer.close((error) => error ? reject(error) : resolve());
        });
      }
    }
  });
});

function setupContext() {
  const rows = new Map<string, Record<string, any>>();
  const tombstones = new Map<string, Date>();
  const db = Object.assign(
    () => {
      let userId = "";
      return {
        where(_field: string, value: string) {
          userId = value;
          return this;
        },
        async first() {
          const deletedAt = tombstones.get(userId);
          return deletedAt ? { userId, deletedAt } : undefined;
        },
        insert(row: { userId: string; deletedAt: Date }) {
          return {
            onConflict() {
              return {
                async merge() {
                  tombstones.set(row.userId, row.deletedAt);
                },
              };
            },
          };
        },
      };
    },
    {
      raw: vi.fn().mockResolvedValue(undefined),
      client: { config: { client: "pg" } },
    },
  );
  const userModel = {
    type: "user",
    hydrate: vi.fn((_adapter, data) => ({ ...data })),
  };
  const adapter = {
    findById: vi.fn(async (_model, id: string) => rows.get(id) ?? null),
    save: vi.fn(async (user: Record<string, any>) => {
      rows.set(user.id, user);
    }),
    remove: vi.fn(async (user: Record<string, any>) => {
      rows.delete(user.id);
    }),
    runInTransaction: vi.fn(async (run: (trx: typeof db) => Promise<unknown>) =>
      run(db),
    ),
  };
  return {
    userModel,
    adapter,
    config: {},
    db,
    rows,
    tombstones,
  } as unknown as AuthSetupContext & {
    rows: typeof rows;
    tombstones: typeof tombstones;
  };
}

function createResponse() {
  let status = 0;
  return {
    res: {
      writeHead(nextStatus: number) {
        status = nextStatus;
      },
      end() {},
    },
    status: () => status,
  };
}
