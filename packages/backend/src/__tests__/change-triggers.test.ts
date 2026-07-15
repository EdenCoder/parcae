/**
 * Unit tests for the LISTEN/NOTIFY trigger DDL helpers.
 *
 * These don't touch Postgres — they validate the SQL templates. Real trigger
 * correctness is covered by the integration suite when Postgres is available.
 */

import { describe, expect, it, vi } from "vitest";

import {
  TRIGGER_FUNCTION_NAME,
  TRIGGER_FUNCTION_VERSION,
  createTriggerSql,
  ensureChangeTriggers,
  triggerFunctionSql,
  triggerName,
  verifyChangeTriggers,
} from "../services/change-triggers";

describe("triggerFunctionSql", () => {
  it("creates the parcae_change_notify function with changed fields", () => {
    const sql = triggerFunctionSql();
    expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${TRIGGER_FUNCTION_NAME}`);
    expect(sql).toContain("pg_notify('parcae_change'");
    expect(sql).toContain("'table'");
    expect(sql).toContain("'op'");
    expect(sql).toContain("'id'");
    expect(sql).toContain("'changedFields'");
    expect(sql).toContain("jsonb_each(to_jsonb(NEW))");
    expect(sql).toContain("IS DISTINCT FROM");
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
    expect(triggerName("projectAssets")).toBe(
      "parcae_change_projectassets",
    );
  });

  it("sanitizes hyphens in kebab-case table names", () => {
    expect(triggerName("chat-messages")).toBe("parcae_change_chat_messages");
    expect(triggerName("priority-walkthroughs")).toBe(
      "parcae_change_priority_walkthroughs",
    );
  });

  it("replaces the trigger atomically so installation is idempotent", () => {
    const sql = createTriggerSql("posts");
    expect(sql).toContain('CREATE OR REPLACE TRIGGER parcae_change_posts');
    expect(sql).toContain('AFTER INSERT OR UPDATE OR DELETE ON "posts"');
    expect(sql).toContain('FOR EACH ROW EXECUTE FUNCTION parcae_change_notify()');
  });

  it("quotes only the table name in DDL, not the sanitized trigger name", () => {
    const sql = createTriggerSql("chat-messages");
    expect(sql).toContain(
      "CREATE OR REPLACE TRIGGER parcae_change_chat_messages",
    );
    expect(sql).toContain(
      'AFTER INSERT OR UPDATE OR DELETE ON "chat-messages"',
    );
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

  it("installs the function once and one trigger per table", async () => {
    const knex = makeKnex();
    await ensureChangeTriggers({
      knex,
      tables: ["posts", "users"],
    });
    expect(knex._calls).toHaveLength(3);
    expect(knex._calls[0]!.sql).toContain(
      `CREATE OR REPLACE FUNCTION ${TRIGGER_FUNCTION_NAME}`,
    );
    expect(knex._calls[1]!.sql).toContain(
      "CREATE OR REPLACE TRIGGER parcae_change_posts",
    );
    expect(knex._calls[2]!.sql).toContain(
      "CREATE OR REPLACE TRIGGER parcae_change_users",
    );
  });

  it("skips when tables array is empty (avoids issuing the function DDL pointlessly)", async () => {
    const knex = makeKnex();
    await ensureChangeTriggers({
      knex,
      tables: [],
    });
    expect(knex.raw).not.toHaveBeenCalled();
  });

  it("fails startup if the function DDL fails", async () => {
    const knex = {
      raw: vi.fn(async (sql: string) => {
        if (sql.includes("CREATE OR REPLACE FUNCTION")) {
          throw new Error("permission denied");
        }
      }),
    };
    await expect(
      ensureChangeTriggers({ knex, tables: ["posts"] }),
    ).rejects.toThrow("permission denied");
    const calls = (knex.raw as any).mock.calls as any[];
    expect(calls).toHaveLength(1);
  });

  it("allows the same trigger name on different tables", async () => {
    const knex = makeKnex();
    await ensureChangeTriggers({
      knex,
      tables: ["chat-messages", "chat_messages"],
    });
    expect(knex.raw).toHaveBeenCalledTimes(3);
  });

  it("fails if a table trigger cannot be installed", async () => {
    let attempt = 0;
    const knex = {
      raw: vi.fn(async (sql: string) => {
        if (
          sql.includes("CREATE OR REPLACE TRIGGER parcae_change_posts") &&
          attempt++ === 0
        ) {
          throw new Error("syntax error");
        }
      }),
    };
    await expect(
      ensureChangeTriggers({ knex, tables: ["posts", "users"] }),
    ).rejects.toThrow("syntax error");
    const calls = (knex.raw as any).mock.calls as any[];
    expect(calls).toHaveLength(2);
  });
});

describe("verifyChangeTriggers", () => {
  it("accepts triggers pointing at the expected function", async () => {
    const knex = {
      raw: vi.fn(async () => ({
        rows: [
          {
            tableName: "posts",
            tableSchema: "public",
            triggerName: "parcae_change_posts",
            triggerEnabled: "O",
            triggerType: 29,
            triggerCondition: null,
            functionName: TRIGGER_FUNCTION_NAME,
            functionSchema: "public",
            functionDefinition: `${TRIGGER_FUNCTION_VERSION}; SELECT pg_notify('parcae_change', '{}')`,
          },
        ],
      })),
    };

    await expect(
      verifyChangeTriggers({ knex, tables: ["posts"] }),
    ).resolves.toBeUndefined();
  });

  it("fails with migration guidance when a trigger is missing", async () => {
    const knex = { raw: vi.fn(async () => ({ rows: [] })) };

    await expect(
      verifyChangeTriggers({ knex, tables: ["posts"] }),
    ).rejects.toThrow(
      "missing realtime triggers for posts; run schema migrations with ENSURE_SCHEMA=true",
    );
  });

  it("rejects a disabled or incorrectly shaped trigger", async () => {
    const knex = {
      raw: vi.fn(async () => ({
        rows: [
          {
            tableName: "posts",
            tableSchema: "public",
            triggerName: "parcae_change_posts",
            triggerEnabled: "D",
            triggerType: 1,
            triggerCondition: "false",
            functionName: TRIGGER_FUNCTION_NAME,
            functionSchema: "public",
            functionDefinition: "old body",
          },
        ],
      })),
    };

    await expect(
      verifyChangeTriggers({ knex, tables: ["posts"] }),
    ).rejects.toThrow("missing realtime triggers for posts");
  });
});
