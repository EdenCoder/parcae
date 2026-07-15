import { Model } from "@parcae/model";
import type { Knex } from "knex";
import { afterEach, beforeEach, expect, it } from "vitest";

import { BackendAdapter } from "../adapters/model";
import { registerModelRoutes } from "../adapters/routes";
import { clearRoutes, getRoutes } from "../routing/route";
import {
  createPostgresTestDatabase,
  describePostgres,
  type PostgresTestDatabase,
} from "./postgres-test";

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

describePostgres("authoritative patch responses", () => {
  let database: PostgresTestDatabase;
  let db: Knex;
  let adapter: BackendAdapter;

  beforeEach(async () => {
    clearRoutes();
    database = await createPostgresTestDatabase();
    db = database.db;
    await db.schema.createTable("authoritativePosts", (table) => {
      table.string("id").primary();
      table.string("title");
      table.dateTime("createdAt");
      table.dateTime("updatedAt");
      table.string("tmp");
      table.jsonb("data");
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
  });

  afterEach(async () => {
    clearRoutes();
    await database.close();
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
