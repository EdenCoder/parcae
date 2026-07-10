import { Model } from "@parcae/model";
import knexFactory from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BackendAdapter } from "../adapters/model";
import { registerModelRoutes } from "../adapters/routes";
import { clearRoutes, getRoutes } from "../routing/route";

class AuthoritativePost extends Model {
  static type = "authoritativePost" as const;
  static scope = { patch: () => () => {} };
  title = "";
}

AuthoritativePost.__schema = { title: "string" };

function makeRes() {
  const captured: { status?: number; body?: any } = {};
  return {
    captured,
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(body: string) {
      captured.body = JSON.parse(body);
    },
  };
}

describe("authoritative patch responses", () => {
  let db: ReturnType<typeof knexFactory>;
  let adapter: BackendAdapter;

  beforeEach(async () => {
    clearRoutes();
    db = knexFactory({
      client: "better-sqlite3",
      connection: { filename: ":memory:" },
      useNullAsDefault: true,
    });
    await db.schema.createTable("authoritativePosts", (table) => {
      table.string("id").primary();
      table.string("title");
      table.dateTime("createdAt");
      table.dateTime("updatedAt");
      table.string("tmp");
      table.text("data");
    });
    await db("authoritativePosts").insert({
      id: "p1",
      title: "before",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      tmp: null,
      data: "{}",
    });
    adapter = new BackendAdapter({ read: db, write: db });
    adapter.engine = "sqlite";
  });

  afterEach(async () => {
    clearRoutes();
    await db.destroy();
  });

  it("returns updatedAt to Model and through the PATCH route", async () => {
    const model = await adapter.findById(AuthoritativePost, "p1");
    expect(model).not.toBeNull();
    await model!.patch([
      { op: "replace", path: "/title", value: "from-model" },
    ]);

    expect(model!.title).toBe("from-model");
    expect(new Date(model!.updatedAt).getTime()).toBeGreaterThan(0);
    expect(new Date(model!.__serverSnapshot.updatedAt).getTime()).toBeGreaterThan(0);

    registerModelRoutes([AuthoritativePost], adapter);
    const route = getRoutes().find(
      (entry) =>
        entry.method === "PATCH" &&
        entry.path === "/v1/authoritativePosts/:id",
    );
    const res = makeRes();
    await route!.handler(
      {
        params: { id: "p1" },
        body: {
          ops: [{ op: "replace", path: "/title", value: "from-route" }],
        },
      },
      res as any,
    );

    expect(res.captured.status).toBe(200);
    expect(res.captured.body.result.title).toBe("from-route");
    expect(new Date(res.captured.body.result.updatedAt).getTime()).toBeGreaterThan(0);
  });
});
