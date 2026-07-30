/**
 * Authorization fingerprint of a JWT: its payload minus the volatile
 * timestamp claims. Two tokens with the same fingerprint grant the same
 * access (same subject, org, role, session), differing only in when they
 * were minted. Auth providers with short-lived JWTs rotate tokens
 * continuously; the fingerprint lets the Provider tell a pure rotation
 * (nothing to do: live sockets authenticate at hello, and every future
 * handshake re-reads the resolver) apart from an authorization change
 * (identity, org, or role moved: the tree must close until the server
 * confirms the new context).
 *
 * Opaque, non-JWT tokens return null, which callers must treat as "cannot
 * compare" and take the full reconciliation path.
 */

const VOLATILE_CLAIMS = new Set(["iat", "exp", "nbf", "jti"]);

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Dependency-free base64url decode; Buffer/atob availability varies across
 * the runtimes this SDK ships to (Node, browsers, Hermes). */
function base64UrlDecode(segment: string): string | null {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  let bits = 0;
  let bitCount = 0;
  let bytes = "";
  for (const char of base64) {
    if (char === "=") break;
    const value = BASE64_ALPHABET.indexOf(char);
    if (value === -1) return null;
    bits = (bits << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes += String.fromCharCode((bits >> bitCount) & 0xff);
    }
  }
  try {
    // Byte string to UTF-8: portable without TextDecoder.
    return decodeURIComponent(escape(bytes));
  } catch {
    return null;
  }
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function _authorizationClaimsFingerprint(token: string): string | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  const decoded = base64UrlDecode(segments[1]!);
  if (decoded === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const stable = Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).filter(
      ([claim]) => !VOLATILE_CLAIMS.has(claim),
    ),
  );
  return canonicalize(stable);
}
