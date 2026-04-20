/**
 * Stripe SDK singleton.
 *
 * Lazy-initialized so that this file can be imported at module-load time
 * without requiring STRIPE_SECRET_KEY to already be set.
 */
import Stripe from "stripe";

let client: Stripe | null = null;

/**
 * Get the shared Stripe client. Throws if STRIPE_SECRET_KEY is unset.
 *
 * Configure once via environment — never pass the secret key through code.
 */
export function stripe(): Stripe {
  if (client) return client;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "[billing/stripe] STRIPE_SECRET_KEY is not set. Configure it in your environment " +
        "before calling billing routes or handlers.",
    );
  }

  client = new Stripe(key, {
    // Pin a known API version. Bump intentionally.
    apiVersion: "2025-10-27.basil" as any,
    appInfo: {
      name: "parcae-billing-stripe",
      version: "0.1.0",
      url: "https://github.com/EdenCoder/parcae",
    },
    typescript: true,
  });

  return client;
}

/**
 * Reset the singleton — test-only. Calls fresh `new Stripe()` on next access.
 */
export function resetStripeClient(): void {
  client = null;
}
