/**
 * Unit tests for the LISTEN/NOTIFY trigger DDL helpers.
 *
 * These don't touch Postgres — they validate the SQL templates and
 * the per-engine no-op behaviour of `ensureChangeTriggers`. Real
 * trigger correctness is covered by the integration suite when a
 * Postgres instance is available.
 */

import { describe, expect, it, vi } from "vitest";

import {
  TRIGGER_FUNCTION_NAME,
  createTriggerSql,
  ensureChangeTriggers,
  triggerFunctionSql,
  triggerName,
} from "../services/changeTriggers";

describe("triggerFunctionSql", () => {
  it("creates the parcae_change_notify function with current_setting safe-read", () => {
    const sql = triggerFunctionSql();
    expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${TRIGGER_FUNCTION_NAME}`);
    expect(sql).toContain("current_setting('parcae.request_id', true)");
    expect(sql).toContain("pg_notify('parcae_change'");
    expect(sql).toContain("'table'");
    expect(sql).toContain("'op'");
    expect(sql).toContain("'id'");
    expect(sql).toContain("'requestId'");
  });

  it("handles DELETE by reading OLD.id, INSERT/UPDATE by NEW.id", () => {
    const sql = triggerFunctionSql();
    expect(sql).toContain("IF TG_OP = 'DELETE' THEN");
    expect(sql).toContain("row_id := OLD.id");
    expect(sql).toContain("row_id := NEW.id");
  });
});

describe("createTriggerSql", () => {
  it("prefixes the trigger name with the table for namespacing", () => {
    expect(triggerName("posts")).toBe("parcae_change_posts");
  });

  it("emits a DROP-then-CREATE pair so the install is idempotent", () => {
    const sql = createTriggerSql("posts");
    expect(sql).toContain('DROP TRIGGER IF EXISTS parcae_change_posts ON "posts"');
    expect(sql).toContain('CREATE TRIGGER parcae_change_posts');
    expect(sql).toContain('AFTER INSERT OR UPDATE OR DELETE ON "posts"');
    expect(sql).toContain('FOR EACH ROW EXECUTE FUNCTION parcae_change_notify()');
  });
});

describe("ensureChangeTriggers", () => {
  function makeKnex() {
    const calls: Array<{ sql: string; bindings?: any[] }> = [];
    return {
      raw: vi.fn(async (sql: string, bindings?: any[]) => {
        calls.push({ sql, bindings });
      }),
      _calls: calls,
    };
  }

  it("is a no-op on SQLite", async () => {
    const knex = makeKnex();
    await ensureChangeTriggers({
      knex,
      engine: "sqlite",
      tables: ["posts", "users"],
    });
    expect(knex.raw).not.toHaveBeenCalled();
  });

  it("installs the function once and a per-table trigger pair", async () => {
    const knex = makeKnex();
    await ensureChangeTriggers({
      knex,
      engine: "postgres",
      tables: ["posts", "users"],
    });
    // One CREATE OR REPLACE FUNCTION + (DROP + CREATE) * 2 = 5.
    expect(knex._calls).toHaveLength(5);
    expect(knex._calls[0]!.sql).toContain(
      `CREATE OR REPLACE FUNCTION ${TRIGGER_FUNCTION_NAME}`,
    );
    expect(knex._calls[1]!.sql).toContain(
      'DROP TRIGGER IF EXISTS parcae_change_posts',
    );
    expect(knex._calls[2]!.sql).toContain("CREATE TRIGGER parcae_change_posts");
    expect(knex._calls[3]!.sql).toContain(
      'DROP TRIGGER IF EXISTS parcae_change_users',
    );
    expect(knex._calls[4]!.sql).toContain("CREATE TRIGGER parcae_change_users");
  });

  it("skips when tables array is empty (avoids issuing the function DDL pointlessly)", async () => {
    const knex = makeKnex();
    await ensureChangeTriggers({
      knex,
      engine: "postgres",
      tables: [],
    });
    expect(knex.raw).not.toHaveBeenCalled();
  });

  it("logs and continues if the function DDL fails", async () => {
    const knex = {
      raw: vi.fn(async (sql: string) => {
        if (sql.includes("CREATE OR REPLACE FUNCTION")) {
          throw new Error("permission denied");
        }
      }),
    };
    await ensureChangeTriggers({
      knex,
      engine: "postgres",
      tables: ["posts"],
    });
    // After the function failed, we should NOT have tried to install
    // the per-table triggers (they reference a missing function).
    const calls = (knex.raw as any).mock.calls as any[];
    expect(calls).toHaveLength(1);
  });

  it("continues to the next table when one trigger install fails", async () => {
    let attempt = 0;
    const knex = {
      raw: vi.fn(async (sql: string) => {
        if (
          sql.includes("CREATE TRIGGER parcae_change_posts") &&
          attempt++ === 0
        ) {
          throw new Error("syntax error");
        }
      }),
    };
    await ensureChangeTriggers({
      knex,
      engine: "postgres",
      tables: ["posts", "users"],
    });
    // Function DDL ran (1), posts triggers attempted (2: DROP + CREATE),
    // users triggers ran (2: DROP + CREATE) — 5 total. The CREATE for
    // posts threw, but we kept going.
    const calls = (knex.raw as any).mock.calls as any[];
    expect(calls).toHaveLength(5);
  });
});
