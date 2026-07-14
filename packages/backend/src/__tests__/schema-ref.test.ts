import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { Model, type Ref } from "@parcae/model";

import { SchemaResolver } from "../schema/resolver";

class RefUser extends Model {
  static override type = "ref-user" as const;
  name = "";
}

type RefUserAlias = Ref<RefUser>;
type MaybeRefUserAlias = Ref<RefUser> | null;
type ModelRef<T extends Model> = Ref<T>;
type ChainedModelRef<T extends Model> = ModelRef<T>;

class RefDateRecord extends Model {
  static override type = "ref-date-record" as const;
  value = "";
}

class RefPost extends Model {
  static override type = "ref-post" as const;
  user!: Ref<RefUser>;
  editor: Ref<RefUser> | null = null;
  reviewer!: RefUserAlias;
  approver: MaybeRefUserAlias = null;
  owner!: ModelRef<RefUser>;
  chained!: ChainedModelRef<RefUser>;
  dated!: Ref<RefDateRecord>;
}

class JsonPost extends Model {
  static override type = "json-post" as const;
  payload: { id: string; name?: string } | string | { value: string } = { value: "" };
}

class LegacyPost extends Model {
  static override type = "legacy-post" as const;
  user!: RefUser;
}

class InvalidRefPost extends Model {
  static override type = "invalid-ref-post" as const;
  owner!: Ref<Model>;
}

namespace Other {
  export type Ref<T> = { value: T };
}

class StructuralRefPost extends Model {
  static override type = "structural-ref-post" as const;
  payload: Other.Ref<string> = { value: "" };
}

describe("SchemaResolver Ref<T>", () => {
  it("stores raw-or-expanded refs as reference columns", () => {
    const resolver = new SchemaResolver();
    const schemas = resolver.resolveFromFiles(
      [RefUser, RefDateRecord, RefPost, JsonPost, StructuralRefPost],
      [fileURLToPath(import.meta.url)],
    );
    resolver.resolveRefTargets(schemas, [
      RefUser,
      RefDateRecord,
      RefPost,
      JsonPost,
      StructuralRefPost,
    ]);

    const schema = schemas.get(RefPost.type);
    expect(schema?.user).toEqual({ kind: "ref", target: RefUser });
    expect(schema?.editor).toEqual({ kind: "ref", target: RefUser });
    expect(schema?.reviewer).toEqual({ kind: "ref", target: RefUser });
    expect(schema?.approver).toEqual({ kind: "ref", target: RefUser });
    expect(schema?.owner).toEqual({ kind: "ref", target: RefUser });
    expect(schema?.chained).toEqual({ kind: "ref", target: RefUser });
    expect(schema?.dated).toEqual({ kind: "ref", target: RefDateRecord });
    expect(schemas.get(JsonPost.type)?.payload).toBe("json");
    expect(schemas.get(StructuralRefPost.type)?.payload).toBe("json");
  });

  it("rejects bare Model reference declarations", () => {
    const resolver = new SchemaResolver();
    expect(() =>
      resolver.resolveFromFiles(
        [RefUser, LegacyPost],
        [fileURLToPath(import.meta.url)],
      ),
    ).toThrow('must be declared with Ref<T>');
  });

  it("rejects non-concrete Ref targets", () => {
    const resolver = new SchemaResolver();
    expect(() =>
      resolver.resolveFromFiles(
        [InvalidRefPost],
        [fileURLToPath(import.meta.url)],
      ),
    ).toThrow('must be one concrete Model subclass');
  });
});
