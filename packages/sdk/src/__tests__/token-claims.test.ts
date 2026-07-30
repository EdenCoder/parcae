import { describe, expect, it } from "vitest";
import { _authorizationClaimsFingerprint } from "../token-claims";

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function jwt(payload: object): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

const CLAIMS = {
  sub: "user_1",
  iss: "https://clerk.example",
  sid: "sess_1",
  org_id: "org_1",
  org_role: "org:member",
};

describe("_authorizationClaimsFingerprint", () => {
  it("matches two rotations of the same authorization", () => {
    const first = jwt({ ...CLAIMS, iat: 1000, exp: 1060, nbf: 995, jti: "a" });
    const second = jwt({ ...CLAIMS, iat: 1030, exp: 1090, nbf: 1025, jti: "b" });
    expect(_authorizationClaimsFingerprint(first)).toBe(
      _authorizationClaimsFingerprint(second),
    );
  });

  it("is insensitive to claim ordering", () => {
    const ordered = jwt({ sub: "user_1", org_id: "org_1" });
    const reversed = jwt({ org_id: "org_1", sub: "user_1" });
    expect(_authorizationClaimsFingerprint(ordered)).toBe(
      _authorizationClaimsFingerprint(reversed),
    );
  });

  it("differs when the subject changes", () => {
    expect(_authorizationClaimsFingerprint(jwt(CLAIMS))).not.toBe(
      _authorizationClaimsFingerprint(jwt({ ...CLAIMS, sub: "user_2" })),
    );
  });

  it("differs when the org or role changes", () => {
    expect(_authorizationClaimsFingerprint(jwt(CLAIMS))).not.toBe(
      _authorizationClaimsFingerprint(jwt({ ...CLAIMS, org_id: "org_2" })),
    );
    expect(_authorizationClaimsFingerprint(jwt(CLAIMS))).not.toBe(
      _authorizationClaimsFingerprint(jwt({ ...CLAIMS, org_role: "org:admin" })),
    );
  });

  it("differs when a new session id is minted", () => {
    expect(_authorizationClaimsFingerprint(jwt(CLAIMS))).not.toBe(
      _authorizationClaimsFingerprint(jwt({ ...CLAIMS, sid: "sess_2" })),
    );
  });

  it("compares nested claims structurally", () => {
    const a = jwt({ sub: "user_1", o: { id: "org_1", rol: "member" } });
    const b = jwt({ sub: "user_1", o: { rol: "member", id: "org_1" } });
    const c = jwt({ sub: "user_1", o: { id: "org_1", rol: "admin" } });
    expect(_authorizationClaimsFingerprint(a)).toBe(
      _authorizationClaimsFingerprint(b),
    );
    expect(_authorizationClaimsFingerprint(a)).not.toBe(
      _authorizationClaimsFingerprint(c),
    );
  });

  it("returns null for opaque tokens", () => {
    expect(_authorizationClaimsFingerprint("opaque-session-token")).toBeNull();
    expect(_authorizationClaimsFingerprint("a.b")).toBeNull();
    expect(_authorizationClaimsFingerprint(`x.${"!!!"}.y`)).toBeNull();
    expect(
      _authorizationClaimsFingerprint(`x.${b64url([1, 2, 3] as never)}.y`),
    ).toBeNull();
  });
});
