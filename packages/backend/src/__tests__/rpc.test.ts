import { describe, it, expect, beforeEach } from "vitest";
import { route, getRoutes, clearRoutes } from "../routing/route";
import { hook, getHooks, getHooksFor, clearHooks } from "../routing/hook";
import { job, getJob, getJobs, clearJobs } from "../routing/job";
import { cron, getCron, getCrons, clearCrons } from "../routing/cron";
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
    // 'save' registrations alias 'create' — the first save IS a create
    // (see hook-save-create-alias.test.ts).
    expect(hooks[0]!.actions).toEqual(["save", "create"]);
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
    // RUN_* flags are undefined at the raw-config layer; resolution
    // into booleans happens in resolveRuntimeFlags().
    expect(config.RUN_SERVER).toBeUndefined();
    expect(config.RUN_HOOKS).toBeUndefined();
    expect(config.RUN_JOBS).toBeUndefined();
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

  it("RUN_HOOKS / RUN_JOBS=false override defaults", () => {
    const cfg = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      RUN_HOOKS: "false",
      RUN_JOBS: "false",
    });
    const flags = resolveRuntimeFlags(cfg);
    expect(flags.hooks).toBe(false);
    expect(flags.jobs).toBe(false);
  });

  it("RUN_SERVER=false takes effect when set", () => {
    const cfg = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      RUN_SERVER: "false",
    });
    expect(resolveRuntimeFlags(cfg).server).toBe(false);
  });
});

describe("cron registration", () => {
  beforeEach(() => clearCrons());

  it("registers a cron and returns the entry", () => {
    const entry = cron("daily-digest", "0 7 * * *", () => {});
    expect(entry.name).toBe("daily-digest");
    expect(entry.pattern).toBe("0 7 * * *");
    expect(getCrons().length).toBe(1);
    expect(getCron("daily-digest")).toBe(entry);
  });

  it("supports per-cron options (overlap, timezone)", () => {
    const entry = cron("metrics", "*/10 * * * *", () => {}, {
      overlap: true,
      timezone: "America/New_York",
    });
    expect(entry.options.overlap).toBe(true);
    expect(entry.options.timezone).toBe("America/New_York");
  });

  it("rejects duplicate names", () => {
    cron("only-once", "* * * * *", () => {});
    expect(() => cron("only-once", "* * * * *", () => {})).toThrow(/duplicate/);
  });

  it("rejects empty name / pattern", () => {
    expect(() => cron("", "* * * * *", () => {})).toThrow(/name is required/);
    expect(() => cron("foo", "", () => {})).toThrow(/pattern is required/);
  });

  it("clearCrons() resets the registry between tests", () => {
    cron("a", "* * * * *", () => {});
    cron("b", "* * * * *", () => {});
    expect(getCrons().length).toBe(2);
    clearCrons();
    expect(getCrons().length).toBe(0);
  });
});

describe("resolveRuntimeFlags — RUN_CRONS", () => {
  it("defaults to true when jobs are enabled", () => {
    const cfg = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      RUN_JOBS: "true",
    });
    expect(resolveRuntimeFlags(cfg).crons).toBe(true);
  });

  it("defaults to false when jobs are disabled (server-only process)", () => {
    const cfg = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      RUN_JOBS: "false",
    });
    expect(resolveRuntimeFlags(cfg).crons).toBe(false);
  });

  it("honours explicit RUN_CRONS=true / false / name-list", () => {
    const t = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      RUN_CRONS: "true",
    });
    expect(resolveRuntimeFlags(t).crons).toBe(true);

    const f = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      RUN_CRONS: "false",
    });
    expect(resolveRuntimeFlags(f).crons).toBe(false);

    const named = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      RUN_CRONS: "daily-digest, cleanup",
    });
    const flags = resolveRuntimeFlags(named).crons;
    expect(flags).toBeInstanceOf(Set);
    expect([...(flags as ReadonlySet<string>)]).toEqual([
      "daily-digest",
      "cleanup",
    ]);
  });

  it("RUN_CRONS overrides the jobs-derived default", () => {
    const cfg = parseConfig({
      DATABASE_URL: "postgres://localhost/test",
      RUN_JOBS: "true",
      RUN_CRONS: "false",
    });
    expect(resolveRuntimeFlags(cfg).jobs).toBe(true);
    expect(resolveRuntimeFlags(cfg).crons).toBe(false);
  });
});

describe("QueueService — per-job-name queue routing", () => {
  // No Redis URL → no connection; we're only exercising the naming helpers
  // and the configured defaultName, which work without a backing Redis.
  it("derives per-job queue names with the default namespace", () => {
    const q = new QueueService();
    expect(q.defaultName).toBe("parcae");
    expect(q.queueNameFor("panel")).toBe("parcae-panel");
    expect(q.queueNameFor("post.index")).toBe("parcae-post.index");
    // Dot-notation job names (the dollhouse convention) survive intact.
    expect(q.queueNameFor("project-asset.panel.process")).toBe(
      "parcae-project-asset.panel.process",
    );
  });

  it("collapses colons in job names — BullMQ v5 rejects them in queues", () => {
    const q = new QueueService();
    // The `post:index` convention from older parcae docs/examples still
    // works at the `enqueue("post:index", …)` layer; only the derived
    // BullMQ queue name is sanitised.
    expect(q.queueNameFor("post:index")).toBe("parcae-post-index");
    expect(q.queueNameFor("a:b:c")).toBe("parcae-a-b-c");
  });

  it("honours a custom defaultName", () => {
    const q = new QueueService({ name: "myapp" });
    expect(q.defaultName).toBe("myapp");
    expect(q.queueNameFor("panel")).toBe("myapp-panel");
  });

  it("get() returns null without a Redis connection", () => {
    // Without REDIS_URL we can't instantiate Queues — confirms the safe
    // fallback so unit tests don't accidentally open Redis sockets.
    const q = new QueueService();
    expect(q.get()).toBeNull();
    expect(q.get("parcae-panel")).toBeNull();
  });
});
