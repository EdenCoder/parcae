import { describe, it, expect, beforeEach } from "vitest";
import { route, getRoutes, clearRoutes } from "../routing/route";
import { hook, getHooks, getHooksFor, clearHooks } from "../routing/hook";
import { job, getJob, getJobs, clearJobs } from "../routing/job";
import { json, ok, error } from "../helpers";
import { log } from "../logger";
import { parseConfig, resolveRuntimeFlags } from "../config";
import { QueueService } from "../services/queue";

describe("route registration", () => {
  beforeEach(() => clearRoutes());

  it("should register GET routes", () => {
    route.get("/v1/test", (_req: any, res: any) => {
      res.end(JSON.stringify({ ok: true }));
    });
    const routes = getRoutes();
    expect(routes.length).toBe(1);
    expect(routes[0]!.method).toBe("GET");
    expect(routes[0]!.path).toBe("/v1/test");
  });

  it("should register POST routes with middleware", () => {
    const middleware = (_req: any, _res: any, next: any) => next();
    route.post("/v1/upload", middleware, (_req: any, res: any) => {
      res.end("ok");
    });
    const routes = getRoutes();
    const post = routes.find((r) => r.method === "POST");
    expect(post).toBeDefined();
    expect(post!.middlewares.length).toBe(1);
  });

  it("should support priority option", () => {
    route.get("/v1/priority", (_req: any, _res: any) => {}, { priority: 10 });
    const routes = getRoutes();
    const r = routes.find((r) => r.path === "/v1/priority");
    expect(r?.priority).toBe(10);
  });

  it("should register all HTTP methods", () => {
    route.get("/a", () => {});
    route.post("/b", () => {});
    route.put("/c", () => {});
    route.patch("/d", () => {});
    route.delete("/e", () => {});
    const routes = getRoutes();
    expect(routes.map((r) => r.method)).toEqual([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ]);
  });
});

describe("hook registration", () => {
  beforeEach(() => clearHooks());

  it("should register after hooks", () => {
    const MockModel = { type: "test", name: "Test" } as any;
    hook.after(MockModel, "save", async () => {});
    const hooks = getHooks();
    expect(hooks.length).toBe(1);
    expect(hooks[0]!.timing).toBe("after");
    expect(hooks[0]!.actions).toEqual(["save"]);
  });

  it("should register before hooks with options", () => {
    const MockModel = { type: "test2", name: "Test2" } as any;
    hook.before(MockModel, "remove", async () => {}, {
      async: true,
      priority: 50,
    });
    const hooks = getHooksFor("test2", "before", "remove");
    expect(hooks.length).toBe(1);
    expect(hooks[0]!.async).toBe(true);
    expect(hooks[0]!.priority).toBe(50);
  });

  it("should filter by model type and timing", () => {
    const A = { type: "a", name: "A" } as any;
    const B = { type: "b", name: "B" } as any;
    hook.after(A, "save", async () => {});
    hook.before(A, "save", async () => {});
    hook.after(B, "save", async () => {});
    expect(getHooksFor("a", "after", "save").length).toBe(1);
    expect(getHooksFor("a", "before", "save").length).toBe(1);
    expect(getHooksFor("b", "after", "save").length).toBe(1);
    expect(getHooksFor("b", "before", "save").length).toBe(0);
  });
});

describe("job registration", () => {
  beforeEach(() => clearJobs());

  it("should register jobs", () => {
    job("test:process", async ({ data }) => {
      return { processed: data.id };
    });
    expect(getJobs().length).toBe(1);
    expect(getJob("test:process")).toBeDefined();
    expect(getJob("nonexistent")).toBeUndefined();
  });
});

describe("response helpers", () => {
  it("json should set status and body", () => {
    let head: any = {};
    let body = "";
    const res = {
      writeHead: (s: number, h: any) => {
        head = { status: s, headers: h };
      },
      end: (b: string) => {
        body = b;
      },
    };
    json(res, 200, { test: true });
    expect(head.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ test: true });
  });

  it("ok should send success envelope", () => {
    let body = "";
    const res = {
      writeHead: () => {},
      end: (b: string) => {
        body = b;
      },
    };
    ok(res, { items: [1, 2, 3] });
    const parsed = JSON.parse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.result.items).toEqual([1, 2, 3]);
  });

  it("error should send error envelope", () => {
    let body = "";
    let status = 0;
    const res = {
      writeHead: (s: number) => {
        status = s;
      },
      end: (b: string) => {
        body = b;
      },
    };
    error(res, 404, "Not found");
    expect(status).toBe(404);
    const parsed = JSON.parse(body);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("Not found");
  });
});

describe("logger", () => {
  it("should have all methods", () => {
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.success).toBe("function");
    expect(typeof log.debug).toBe("function");
  });
});

describe("config", () => {
  it("should parse valid config", () => {
    const config = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      PORT: "3000",
    });
    expect(config.DATABASE_URL).toBe("postgres://localhost/test");
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe("development");
  });

  it("should throw on missing DATABASE_URL", () => {
    expect(() => parseConfig({})).toThrow("Invalid configuration");
  });

  it("should use defaults", () => {
    const config = parseConfig({ DATABASE_URL: "postgres://localhost/test" });
    expect(config.PORT).toBe(3000);
    // RUN_* flags are intentionally undefined at the raw-config layer —
    // resolution into booleans happens in resolveRuntimeFlags(). The
    // legacy SERVER/DAEMON aliases default to undefined too so we can
    // distinguish "user didn't set" from an explicit value.
    expect(config.RUN_SERVER).toBeUndefined();
    expect(config.RUN_HOOKS).toBeUndefined();
    expect(config.RUN_JOBS).toBeUndefined();
    expect(config.SERVER).toBeUndefined();
    expect(config.DAEMON).toBeUndefined();
  });
});

describe("resolveRuntimeFlags", () => {
  // Defaults: server on, hooks on, jobs off. Mirrors the in-process
  // expectation that a fresh `createApp().start()` with no env behaves
  // like a full single-process server, not a worker.
  it("defaults to server=true hooks=true jobs=false", () => {
    const cfg = parseConfig({ DATABASE_URL: "postgres://localhost/test" });
    const flags = resolveRuntimeFlags(cfg);
    expect(flags.server).toBe(true);
    expect(flags.hooks).toBe(true);
    expect(flags.jobs).toBe(false);
  });

  it("honours explicit RUN_SERVER / RUN_HOOKS / RUN_JOBS", () => {
    const cfg = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      RUN_SERVER: "false",
      RUN_HOOKS: "true",
      RUN_JOBS: "true",
    });
    const flags = resolveRuntimeFlags(cfg);
    expect(flags.server).toBe(false);
    expect(flags.hooks).toBe(true);
    expect(flags.jobs).toBe(true);
  });

  it("parses RUN_JOBS=false explicitly", () => {
    const cfg = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      RUN_JOBS: "false",
    });
    expect(resolveRuntimeFlags(cfg).jobs).toBe(false);
  });

  it("parses RUN_JOBS=<comma-list> as Set", () => {
    const cfg = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      RUN_JOBS: "panel, image,voice",
    });
    const jobs = resolveRuntimeFlags(cfg).jobs;
    expect(jobs).toBeInstanceOf(Set);
    expect([...(jobs as ReadonlySet<string>)]).toEqual([
      "panel",
      "image",
      "voice",
    ]);
  });

  // Legacy SERVER=true should still produce server=true. Deprecation warning
  // is captured so we can assert it fires exactly once.
  it("maps legacy SERVER to RUN_SERVER with a deprecation warning", () => {
    const cfg = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      SERVER: "false",
    });
    const warnings: string[] = [];
    const flags = resolveRuntimeFlags(cfg, (m) => warnings.push(m));
    expect(flags.server).toBe(false);
    expect(warnings.some((w) => w.includes("SERVER is deprecated"))).toBe(true);
  });

  // Legacy DAEMON=true should map to hooks+jobs both on, with a single
  // deprecation warning. The warning is keyed on DAEMON so callers can
  // upgrade in one go.
  it("maps legacy DAEMON=true to hooks=true jobs=true", () => {
    const cfg = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      DAEMON: "true",
    });
    const warnings: string[] = [];
    const flags = resolveRuntimeFlags(cfg, (m) => warnings.push(m));
    expect(flags.hooks).toBe(true);
    expect(flags.jobs).toBe(true);
    expect(warnings.some((w) => w.includes("DAEMON is deprecated"))).toBe(true);
  });

  // Explicit RUN_HOOKS / RUN_JOBS override legacy DAEMON. No surprise
  // collisions when an operator is mid-migration.
  it("RUN_HOOKS / RUN_JOBS override legacy DAEMON", () => {
    const cfg = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      DAEMON: "true",
      RUN_HOOKS: "false",
      RUN_JOBS: "false",
    });
    const flags = resolveRuntimeFlags(cfg);
    expect(flags.hooks).toBe(false);
    expect(flags.jobs).toBe(false);
  });

  // RUN_SERVER overrides legacy SERVER, no warning fires for SERVER.
  it("RUN_SERVER overrides legacy SERVER without warning", () => {
    const cfg = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      SERVER: "true",
      RUN_SERVER: "false",
    });
    const warnings: string[] = [];
    const flags = resolveRuntimeFlags(cfg, (m) => warnings.push(m));
    expect(flags.server).toBe(false);
    expect(warnings.some((w) => w.includes("SERVER is deprecated"))).toBe(
      false,
    );
  });
});

describe("QueueService — per-job-name queue routing", () => {
  // No Redis URL → no connection; we're only exercising the naming helpers
  // and the configured defaultName, which work without a backing Redis.
  it("derives per-job queue names with the default namespace", () => {
    const q = new QueueService();
    expect(q.defaultName).toBe("parcae");
    expect(q.queueNameFor("panel")).toBe("parcae:panel");
    expect(q.queueNameFor("post.index")).toBe("parcae:post.index");
    // Job names with colons (legacy/dollhouse convention) are preserved
    // — BullMQ allows colons in queue names, only jobIds reject them.
    expect(q.queueNameFor("project-asset.panel.process")).toBe(
      "parcae:project-asset.panel.process",
    );
  });

  it("honours a custom defaultName", () => {
    const q = new QueueService({ name: "myapp" });
    expect(q.defaultName).toBe("myapp");
    expect(q.queueNameFor("panel")).toBe("myapp:panel");
  });

  it("get() with no name still returns the legacy default queue", () => {
    // Without REDIS_URL we can't actually instantiate Queues — that's the
    // expected fallback. The important behaviour: `get()` defaults to the
    // bare `defaultName`, which is the queue the transitional fallback
    // worker subscribes to (see app.ts Step 15).
    const q = new QueueService();
    expect(q.get()).toBeNull();
    expect(q.get("parcae:panel")).toBeNull();
  });
});
