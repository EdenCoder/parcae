/**
 * POST /v1/billing/portal
 *
 * Creates a Stripe Customer Portal session for the authenticated user and
 * returns the redirect URL. The portal lets users self-serve payment method
 * updates, invoice downloads, plan changes, and cancellation.
 */
import { route, ok, notFound } from "@parcae/backend";
import { stripe } from "../lib/stripe";
import { requireBillingAuth } from "../lib/auth";
import { Customer } from "../models/billing/Customer";

interface PortalBody {
  /** Where Stripe returns the user after they close the portal. */
  returnUrl?: string;
  /** Optional configuration ID for a branded/themed portal. */
  configuration?: string;
}

route.post(
  "/v1/billing/portal",
  requireBillingAuth,
  async (req: any, res: any) => {
    const body = (req.body ?? {}) as PortalBody;
    const userId: string = req.userId;

    const customer = await (Customer as any).where({ user: userId }).first();
    if (!customer?.stripeCustomerId) {
      notFound(res, "No Stripe customer found for user");
      return;
    }

    const returnUrl =
      body.returnUrl ||
      process.env.STRIPE_PORTAL_RETURN_URL ||
      `${process.env.FRONTEND_URL ?? ""}/settings/billing`;

    const s = stripe();
    const session = await s.billingPortal.sessions.create({
      customer: customer.stripeCustomerId,
      return_url: returnUrl,
      configuration: body.configuration,
    });

    ok(res, { url: session.url });
  },
);
