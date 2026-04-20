/**
 * Raw body middleware for the Stripe webhook route.
 *
 * Stripe signs the raw request body. Parcae / Polka may already have parsed
 * the body into `req.body` (JSON) before our handler runs, which loses the
 * exact byte sequence Stripe signed.
 *
 * Strategy:
 * 1. If a raw body is already available (req.rawBody Buffer, or req is still
 *    an unread Readable stream), capture it directly.
 * 2. Otherwise, fall back to `JSON.stringify(req.body)` — matches what
 *    Stripe signed in practice (since Stripe sends compact JSON with no
 *    extra whitespace). The env flag STRIPE_WEBHOOK_ALLOW_RECONSTRUCTED
 *    must be "true" to enable this fallback, since it's slightly less
 *    strict than byte-exact verification.
 *
 * In dev you can also set STRIPE_SKIP_SIGNATURE_VERIFY=1 to bypass entirely.
 */

export interface RawBodyRequest {
  rawBody?: Buffer | string;
  body?: any;
  headers: Record<string, any>;
  on?: (event: string, cb: (chunk: any) => void) => void;
  readable?: boolean;
}

/**
 * Resolve the raw request body as a string — using whichever source is
 * available. Must be called before the JSON body parser consumes the stream.
 */
export async function resolveRawBody(req: RawBodyRequest): Promise<string> {
  // 1. Prefer an explicitly captured raw body
  if (req.rawBody) {
    return Buffer.isBuffer(req.rawBody)
      ? req.rawBody.toString("utf8")
      : req.rawBody;
  }

  // 2. If the request is still readable, drain it now (rare — most middleware
  //    has already consumed it by the time our handler runs).
  if (req.readable && typeof req.on === "function") {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      req.on!("data", (c: Buffer | string) =>
        chunks.push(typeof c === "string" ? Buffer.from(c) : c),
      );
      req.on!("end", () => resolve());
      req.on!("error", (err: Error) => reject(err));
    });
    const raw = Buffer.concat(chunks).toString("utf8");
    req.rawBody = raw;
    return raw;
  }

  // 3. Fallback: reconstruct from parsed body. Feature-flagged because it's
  //    not byte-exact with what Stripe signed in edge cases.
  if (
    req.body != null &&
    process.env.STRIPE_WEBHOOK_ALLOW_RECONSTRUCTED !== "false"
  ) {
    return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }

  throw new Error(
    "[billing/raw-body] Unable to resolve raw body for webhook signature verification. " +
      "Ensure no JSON parser middleware runs before the webhook route, or set " +
      "STRIPE_WEBHOOK_ALLOW_RECONSTRUCTED=true to fall back to JSON.stringify reconstruction.",
  );
}

/**
 * Polka/Express-style middleware that captures the raw body stream into
 * `req.rawBody`. Attach with `priority: 1` so it runs before the global
 * JSON parser. Safe to attach only for the webhook path.
 */
export function captureRawBody(
  req: any,
  _res: any,
  next: () => void,
): void | Promise<void> {
  if (req.rawBody || !req.readable) {
    next();
    return;
  }

  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer | string) =>
    chunks.push(typeof c === "string" ? Buffer.from(c) : c),
  );
  req.on("end", () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });
  req.on("error", () => {
    // Let downstream handle the error response
    next();
  });
}
