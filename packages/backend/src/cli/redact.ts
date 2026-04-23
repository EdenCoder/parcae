/**
 * @parcae/backend — CLI secret redaction
 *
 * Small helper used by the dispatcher to scrub password-looking tokens from
 * error messages and stack traces before they hit stderr. pg's connect-error
 * messages routinely embed `user:password@host` from the connection string;
 * CI log archival then captures credentials verbatim.
 */

/**
 * Redact credentials from a string, handling two cases:
 *
 * 1. Any URL-shaped `scheme://user:password@host` occurrence — replaced with
 *    `scheme://user:***@host`.
 * 2. If a specific URL is provided, scrub any exact occurrence of it too —
 *    defence in depth against drivers that log the URL verbatim without the
 *    `://` prefix.
 */
export function redactSecrets(message: string, url?: string): string {
  let out = message.replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+):([^\s@]+)@/gi,
    "$1:***@",
  );
  if (url) {
    // Also mask the exact URL if it leaks unescaped
    out = out.split(url).join(redactSecrets(url));
  }
  return out;
}
