import { describe, expect, it } from "vitest";
import type { AuthSetupContext } from "@parcae/backend";
import type { ModelConstructor } from "@parcae/model";
import { betterAuth, inferAdditionalFields } from "../index.js";

const User = {
  type: "user",
  privateFields: ["passwordHash"],
  __schema: {
    role: "string",
    bio: "text",
    passwordHash: "string",
  },
} as unknown as ModelConstructor;

describe("inferAdditionalFields", () => {
  it("keeps inferred role and private fields out of auth input and output", () => {
    const fields = inferAdditionalFields(User);

    expect(fields.role).toMatchObject({ input: false, returned: false });
    expect(fields.passwordHash).toMatchObject({ input: false, returned: false });
  });

  it("only exposes allowlisted non-private fields", () => {
    const fields = inferAdditionalFields(User, {
      input: ["bio", "role", "passwordHash"],
      returned: ["bio", "role", "passwordHash"],
    });

    expect(fields.role).toMatchObject({ input: true, returned: true });
    expect(fields.bio).toMatchObject({ input: true, returned: true });
    expect(fields.passwordHash).toMatchObject({ input: false, returned: false });
  });

  it("rejects every private Better Auth-managed returned field during setup", async () => {
    const auth = betterAuth();
    const userModel = {
      type: "user",
      privateFields: [
        "id",
        "name",
        "email",
        "emailVerified",
        "image",
        "createdAt",
        "updatedAt",
      ],
    } as unknown as ModelConstructor;

    await expect(auth.setup({
      userModel,
      adapter: {},
      config: {},
      db: {},
    } as unknown as AuthSetupContext)).rejects.toThrow(
      "User.privateFields cannot include Better Auth-managed returned fields: id, name, email, emailVerified, image, createdAt, updatedAt",
    );
  });
});
