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

// fva is Clerk's factor-verification age in minutes: a default claim on v2
// session tokens that ticks upward every minute, so it changes across pure
// rotations exactly like the timestamp claims do.
const VOLATILE_CLAIMS = new Set(["iat", "exp", "nbf", "jti", "fva"]);

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Dependency-free base64url decode; Buffer/atob availability varies across
 * the runtimes this SDK ships to (Node, browsers, Hermes). */
function base64UrlDecode(segment: string): string | null {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  let bits = 0;
  let bitCount = 0;
  let bytes = "";
  const paddingStart = base64.indexOf("=");
  if (paddingStart !== -1 && /[^=]/.test(base64.slice(paddingStart))) {
    return null;
  }
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

/** The token's payload minus the volatile claims, or null when the token is
 * not a decodable JWT object. */
export function _authorizationClaims(
  token: string,
): Record<string, unknown> | null {
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
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).filter(
      ([claim]) => !VOLATILE_CLAIMS.has(claim),
    ),
  );
}

export function _fingerprintAuthorizationClaims(
  claims: Record<string, unknown>,
): string {
  return canonicalize(claims);
}

export function _authorizationClaimsFingerprint(token: string): string | null {
  const claims = _authorizationClaims(token);
  return claims === null ? null : canonicalize(claims);
}

/** Top-level claim names whose values differ between two claim sets. Names
 * only, never values: claims can carry identifying data and this feeds logs. */
export function _differingClaimNames(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const names = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...names]
    .filter((name) => canonicalize(previous[name]) !== canonicalize(next[name]))
    .sort();
}
