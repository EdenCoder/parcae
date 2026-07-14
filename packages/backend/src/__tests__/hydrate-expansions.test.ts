/**
 * Unit tests for `hydrate-expansions` — pure parsing / validation /
 * projection logic. Integration with the LIST handler and the
 * subscription manager lives in `expand.test.ts`.
 *
 * Covers the contract documented on `QueryChain.expand` and in the
 * module header of `services/hydrate-expansions.ts`:
 *
 *   - Bare ref spec → whole-row.
 *   - Dotted spec  → field projection (id + type always included).
 *   - Bare wins over per-field on the same ref.
 *   - Comma-separated tokens parse identically to multiple args.
 *   - Nested expand (`"a.b.c"`) → 400.
 *   - Unknown ref / non-ref field → 400.
 *   - Unknown projected target field → 400 (when target schema known).
 *   - `hashKey` is stable + order-independent + projection-aware.
 *   - `hydrateExpansions` preserves `$<ref>` and replaces `<ref>`
 *     with the embedded shape, batched through RefLoader.
 */

import { describe, expect, it, vi } from "vitest";
import { Model, type Ref } from "@parcae/model";
import { ClientError } from "../helpers";
import { RefLoader } from "../services/ref-loader";
import {
  expandHashKey,
  hydrateExpansions,
  parseExpandSpecs,
  projectForWire,
  validateExpandSpecs,
  type ResolvedExpand,
} from "../services/hydrate-expansions";

// ─── Test fixtures ───────────────────────────────────────────────────────────

class FileModel extends Model {
  static override type = "file";
  static override __schema = {
    url: "string",
    mime: "string",
    bytes: "number",
  } as any;
  url: string = "";
  mime: string = "";
  bytes: number = 0;
}

class UserModel extends Model {
  static override type = "user";
  static override __schema = { name: "string" } as any;
  name: string = "";
}

class AssetModel extends Model {
  static override type = "asset";
  static override __schema = {
    name: "string",
    file: { kind: "ref", target: FileModel },
    owner: { kind: "ref", target: UserModel },
  } as any;
  declare file: Ref<FileModel>;
  declare owner: Ref<UserModel>;
}

class CustomSanitizedAsset extends AssetModel {
  static override type = "custom-asset";

  override sanitize(): Record<string, any> {
    return { id: this.id, file: this.file };
  }
}

const REGISTRY = new Map<string, any>([
  ["file", FileModel],
  ["user", UserModel],
  ["asset", AssetModel],
]);

describe("projectForWire", () => {
  it("stamps visible refs returned by a custom sanitizer", async () => {
    const asset = CustomSanitizedAsset.hydrate({} as any, {
      id: "asset-1",
      file: "file-1",
    });

    await expect(projectForWire(asset, null)).resolves.toEqual({
      id: "asset-1",
      file: "file-1",
      $file: "file-1",
    });
  });
});

// ─── parseExpandSpecs ────────────────────────────────────────────────────────

describe("parseExpandSpecs", () => {
  it("returns an empty map for an empty input", () => {
    expect(parseExpandSpecs([])).toEqual(new Map());
  });

  it("parses a bare ref as whole-row", () => {
    const out = parseExpandSpecs(["file"]);
    expect(out.size).toBe(1);
    expect(out.get("file")).toEqual({ whole: true, fields: new Set() });
  });

  it("parses a dotted spec as a single-field projection", () => {
    const out = parseExpandSpecs(["file.url"]);
    expect(out.get("file")).toEqual({
      whole: false,
      fields: new Set(["url"]),
    });
  });

  it("accumulates multiple per-field projections on the same ref", () => {
    const out = parseExpandSpecs(["file.url", "file.mime"]);
    expect(out.get("file")).toEqual({
      whole: false,
      fields: new Set(["url", "mime"]),
    });
  });

  it("treats bare ref as winning over per-field projections (order-insensitive)", () => {
    expect(parseExpandSpecs(["file", "file.url"]).get("file")).toEqual({
      whole: true,
      fields: new Set(),
    });
    expect(parseExpandSpecs(["file.url", "file"]).get("file")).toEqual({
      whole: true,
      fields: new Set(),
    });
  });

  it("accepts comma-separated tokens inside a single arg", () => {
    expect(parseExpandSpecs(["file.url, file.mime"]).get("file")).toEqual({
      whole: false,
      fields: new Set(["url", "mime"]),
    });
  });

  it("trims whitespace around tokens and inner segments", () => {
    expect(parseExpandSpecs(["  file . url "]).get("file")).toEqual({
      whole: false,
      fields: new Set(["url"]),
    });
  });

  it("rejects nested expand (`a.b.c`) — one hop only in v1", () => {
    expect(() => parseExpandSpecs(["project.user.email"])).toThrow(
      ClientError,
    );
    expect(() => parseExpandSpecs(["project.user.email"])).toThrow(
      /Nested expand not supported/,
    );
  });

  it("rejects malformed dotted spec with empty segment", () => {
    expect(() => parseExpandSpecs(["file."])).toThrow(ClientError);
    expect(() => parseExpandSpecs([".url"])).toThrow(ClientError);
  });
});

// ─── validateExpandSpecs ─────────────────────────────────────────────────────

describe("validateExpandSpecs", () => {
  it("resolves a bare ref against the schema and returns whole-row projection", () => {
    const specs = parseExpandSpecs(["file"]);
    const resolved = validateExpandSpecs(specs, AssetModel as any, REGISTRY);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.refField).toBe("file");
    expect(resolved[0]!.targetType).toBe("file");
    expect(resolved[0]!.targetClass).toBe(FileModel);
    expect(resolved[0]!.projection).toBeNull();
  });

  it("preserves projection field sets", () => {
    const specs = parseExpandSpecs(["file.url", "file.mime"]);
    const resolved = validateExpandSpecs(specs, AssetModel as any, REGISTRY);
    expect(resolved[0]!.projection).toEqual(new Set(["url", "mime"]));
  });

  it("rejects expanding a non-ref field as 400", () => {
    const specs = parseExpandSpecs(["name"]);
    expect(() =>
      validateExpandSpecs(specs, AssetModel as any, REGISTRY),
    ).toThrow(ClientError);
    expect(() =>
      validateExpandSpecs(specs, AssetModel as any, REGISTRY),
    ).toThrow(/not a ref field/);
  });

  it("rejects expanding an unknown field as 400", () => {
    const specs = parseExpandSpecs(["wat"]);
    expect(() =>
      validateExpandSpecs(specs, AssetModel as any, REGISTRY),
    ).toThrow(ClientError);
  });

  it("rejects projecting an unknown target column as 400", () => {
    const specs = parseExpandSpecs(["file.nonexistent"]);
    expect(() =>
      validateExpandSpecs(specs, AssetModel as any, REGISTRY),
    ).toThrow(ClientError);
    expect(() =>
      validateExpandSpecs(specs, AssetModel as any, REGISTRY),
    ).toThrow(/not a column on file/);
  });

  it("accepts projecting `id` / `type` / `createdAt` / `updatedAt` (system fields)", () => {
    const specs = parseExpandSpecs([
      "file.id",
      "file.type",
      "file.createdAt",
      "file.updatedAt",
    ]);
    const resolved = validateExpandSpecs(specs, AssetModel as any, REGISTRY);
    expect(resolved).toHaveLength(1);
  });

  it("preserves multiple distinct ref fields", () => {
    const specs = parseExpandSpecs(["file.url", "owner"]);
    const resolved = validateExpandSpecs(specs, AssetModel as any, REGISTRY);
    const byRef = new Map(resolved.map((e) => [e.refField, e]));
    expect(byRef.get("file")!.projection).toEqual(new Set(["url"]));
    expect(byRef.get("owner")!.projection).toBeNull();
  });
});

// ─── expandHashKey ───────────────────────────────────────────────────────────

describe("expandHashKey", () => {
  it("is empty string for no specs", () => {
    expect(expandHashKey(new Map())).toBe("");
  });

  it("is order-independent across ref fields", () => {
    const a = parseExpandSpecs(["file", "owner"]);
    const b = parseExpandSpecs(["owner", "file"]);
    expect(expandHashKey(a)).toBe(expandHashKey(b));
  });

  it("is order-independent across per-field projections on the same ref", () => {
    const a = parseExpandSpecs(["file.url", "file.mime"]);
    const b = parseExpandSpecs(["file.mime", "file.url"]);
    expect(expandHashKey(a)).toBe(expandHashKey(b));
  });

  it("distinguishes whole-row from projected", () => {
    const whole = parseExpandSpecs(["file"]);
    const projected = parseExpandSpecs(["file.url"]);
    expect(expandHashKey(whole)).not.toBe(expandHashKey(projected));
  });

  it("distinguishes different projection sets", () => {
    const a = parseExpandSpecs(["file.url"]);
    const b = parseExpandSpecs(["file.mime"]);
    expect(expandHashKey(a)).not.toBe(expandHashKey(b));
  });
});

// ─── hydrateExpansions ───────────────────────────────────────────────────────

describe("hydrateExpansions", () => {
  it("inlines whole-row refs and stamps $<ref> with the raw id", async () => {
    const items: Record<string, any>[] = [
      { id: "a1", type: "asset", file: "f1", name: "alpha" },
      { id: "a2", type: "asset", file: "f2", name: "beta" },
    ];
    const fileRows = new Map([
      ["f1", buildFile("f1", "https://cdn/1.png", "image/png")],
      ["f2", buildFile("f2", "https://cdn/2.png", "image/png")],
    ]);
    const loadByIds = vi.fn(async (type: string, ids: string[]) => {
      expect(type).toBe("file");
      const m = new Map<string, unknown>();
      for (const id of ids) {
        const row = fileRows.get(id);
        if (row) m.set(id, row);
      }
      return m;
    });
    const loader = new RefLoader(loadByIds);

    const resolved: ResolvedExpand[] = [
      {
        refField: "file",
        targetType: "file",
        targetClass: FileModel as any,
        projection: null,
      },
    ];
    await hydrateExpansions(items, resolved, loader, null);

    expect(loadByIds).toHaveBeenCalledTimes(1);
    expect(items[0]!.file).toMatchObject({
      type: "file",
      id: "f1",
      url: "https://cdn/1.png",
      mime: "image/png",
      bytes: 0,
    });
    expect(items[0]!.$file).toBe("f1");
    expect(items[1]!.file.url).toBe("https://cdn/2.png");
    expect(items[1]!.$file).toBe("f2");
  });

  it("projects to the requested fields, always including id + type", async () => {
    const items: any[] = [{ id: "a1", type: "asset", file: "f1" }];
    const loader = new RefLoader(async (_type, ids) => {
      const m = new Map<string, unknown>();
      for (const id of ids) m.set(id, buildFile(id, "https://x", "image/png"));
      return m;
    });
    const resolved: ResolvedExpand[] = [
      {
        refField: "file",
        targetType: "file",
        targetClass: FileModel as any,
        projection: new Set(["url"]),
      },
    ];
    await hydrateExpansions(items, resolved, loader, null);
    expect(items[0]!.file).toEqual({
      id: "f1",
      type: "file",
      url: "https://x",
    });
    expect(items[0]!.file.mime).toBeUndefined();
  });

  it("dedupes ids across rows — one underlying batch per ref type", async () => {
    const items: any[] = [
      { id: "a1", type: "asset", file: "f1" },
      { id: "a2", type: "asset", file: "f1" },
      { id: "a3", type: "asset", file: "f1" },
    ];
    const loadByIds = vi.fn(async (_type: string, ids: string[]) => {
      const m = new Map<string, unknown>();
      // RefLoader dedupes; we should only see "f1" once.
      expect(ids).toEqual(["f1"]);
      for (const id of ids) {
        m.set(id, buildFile(id, "https://x", "image/png"));
      }
      return m;
    });
    const loader = new RefLoader(loadByIds);
    await hydrateExpansions(
      items,
      [
        {
          refField: "file",
          targetType: "file",
          targetClass: FileModel as any,
          projection: null,
        },
      ],
      loader,
      null,
    );
    expect(loadByIds).toHaveBeenCalledTimes(1);
    expect(items.map((i) => i.file.id)).toEqual(["f1", "f1", "f1"]);
  });

  it("nulls the ref when the linked row is missing, but still stamps $<ref>", async () => {
    const items: any[] = [{ id: "a1", type: "asset", file: "ghost" }];
    const loader = new RefLoader(async () => new Map());
    await hydrateExpansions(
      items,
      [
        {
          refField: "file",
          targetType: "file",
          targetClass: FileModel as any,
          projection: null,
        },
      ],
      loader,
      null,
    );
    expect(items[0]!.file).toBeNull();
    expect(items[0]!.$file).toBe("ghost");
  });

  it("nulls the ref AND stamps $<ref>: null when the row has no ref id", async () => {
    const items: any[] = [{ id: "a1", type: "asset", file: "" }];
    const loadByIds = vi.fn(async () => new Map());
    const loader = new RefLoader(loadByIds);
    await hydrateExpansions(
      items,
      [
        {
          refField: "file",
          targetType: "file",
          targetClass: FileModel as any,
          projection: null,
        },
      ],
      loader,
      null,
    );
    expect(items[0]!.file).toBeNull();
    expect(items[0]!.$file).toBeNull();
    expect(loadByIds).not.toHaveBeenCalled();
  });

  it("batches all refs of the same type across distinct ref fields in one RefLoader flush", async () => {
    // asset has two ref fields onto user (`owner`) and file (`file`).
    // Hydrating both should coalesce per type — 1 query for users,
    // 1 query for files, regardless of how many ref fields point at
    // each.
    const items: any[] = [
      { id: "a1", type: "asset", file: "f1", owner: "u1" },
      { id: "a2", type: "asset", file: "f1", owner: "u2" },
    ];
    const loadByIds = vi.fn(async (type: string, ids: string[]) => {
      const m = new Map<string, unknown>();
      if (type === "file") {
        for (const id of ids) m.set(id, buildFile(id, "x", "image/png"));
      } else if (type === "user") {
        for (const id of ids) {
          const u = UserModel.hydrate({} as any, { id, name: `name-${id}` });
          m.set(id, u);
        }
      }
      return m;
    });
    const loader = new RefLoader(loadByIds);
    await hydrateExpansions(
      items,
      [
        {
          refField: "file",
          targetType: "file",
          targetClass: FileModel as any,
          projection: null,
        },
        {
          refField: "owner",
          targetType: "user",
          targetClass: UserModel as any,
          projection: null,
        },
      ],
      loader,
      null,
    );
    expect(loadByIds).toHaveBeenCalledTimes(2); // one per target type
    expect(items[0]!.file.url).toBe("x");
    expect(items[0]!.owner.name).toBe("name-u1");
    expect(items[1]!.owner.name).toBe("name-u2");
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildFile(id: string, url: string, mime: string): FileModel {
  // `hydrate` is the same factory the adapter uses on a real SQL row.
  // Don't bother with a real adapter — RefLoader handlers only need
  // the resulting object to have `sanitize()` (Model's default
  // implementation).
  return FileModel.hydrate({} as any, { id, url, mime, bytes: 0 }) as FileModel;
}
