/**
 * POST /v1/billing/checkout
 *
 * Creates a Stripe Checkout Session for the authenticated user and returns
 * the redirect URL. Handles both subscriptions (mode: "subscription") and
 * one-time purchases (mode: "payment"), chosen automatically from the
 * resolved Price's `priceType`.
 *
 * Ensures a Stripe Customer exists for the user (creates one on first use).
 */
import { route, ok, badRequest, notFound } from "@parcae/backend";
import { stripe } from "../lib/stripe";
import { requireBillingAuth } from "../lib/auth";
import { Price } from "../models/billing/Price";
import { Customer } from "../models/billing/Customer";
import { upsertCustomer } from "../lib/sync";

interface CheckoutBody {
  /** Parcae Price ID (our local id, not the stripePriceId). Required if no `priceId`. */
  price?: string;
  /** Stripe price ID (price_...). Alternative to `price`. */
  priceId?: string;
  /** Quantity (for seat-based subscriptions). Default 1. */
  quantity?: number;
  /** Promotion code string (e.g. "SUMMER20"). */
  promotionCode?: string;
  /** Override the success / cancel redirect URLs. */
  successUrl?: string;
  cancelUrl?: string;
  /** Metadata attached to the Stripe Checkout Session + resulting Subscription/Invoice. */
  metadata?: Record<string, string>;
}

route.post(
  "/v1/billing/checkout",
  requireBillingAuth,
  async (req: any, res: any) => {
    const body = (req.body ?? {}) as CheckoutBody;
    const userId: string = req.userId;

    // Resolve the Price
    let stripePriceId = body.priceId;
    let priceType: "recurring" | "one_time" = "recurring";

    if (body.price && !stripePriceId) {
      const price = await (Price as any).where({ id: body.price }).first();
      if (!price) {
        notFound(res, "Price not found");
        return;
      }
      stripePriceId = price.stripePriceId;
      priceType = price.priceType ?? "recurring";
    } else if (stripePriceId) {
      // Optional fidelity: look up local Price by stripePriceId to determine mode
      const localPrice = await (Price as any).where({ stripePriceId }).first();
      priceType = localPrice?.priceType ?? "recurring";
    } else {
      badRequest(res, "Must provide `price` or `priceId`");
      return;
    }

    // Ensure local Customer exists (lazily create the Stripe Customer too)
    const s = stripe();
    let customer = await (Customer as any).where({ user: userId }).first();
    if (!customer) {
      const email = req.session?.user?.email ?? "";
      const name = req.session?.user?.name ?? "";
      const stripeCustomer = await s.customers.create({
        email,
        name,
        metadata: { user: userId },
      });
      customer = await upsertCustomer(stripeCustomer, userId, "checkout");
    }

    // Build session params
    const successUrl =
      body.successUrl ||
      process.env.STRIPE_SUCCESS_URL ||
      `${process.env.FRONTEND_URL ?? ""}/settings/billing?success=1`;
    const cancelUrl =
      body.cancelUrl ||
      process.env.STRIPE_CANCEL_URL ||
      `${process.env.FRONTEND_URL ?? ""}/settings/billing?cancel=1`;

    const sessionParams: any = {
      customer: customer.stripeCustomerId,
      mode: priceType === "recurring" ? "subscription" : "payment",
      line_items: [
        {
          price: stripePriceId,
          quantity: body.quantity ?? 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { ...(body.metadata ?? {}), user: userId },
      allow_promotion_codes: true,
    };

    if (body.promotionCode) {
      // Resolve the code to a Stripe promotion_code ID
      const promos = await s.promotionCodes.list({
        code: body.promotionCode,
        active: true,
        limit: 1,
      });
      if (promos.data[0]) {
        sessionParams.discounts = [{ promotion_code: promos.data[0].id }];
        delete sessionParams.allow_promotion_codes;
      }
    }

    const session = await s.checkout.sessions.create(sessionParams);

    ok(res, { url: session.url, id: session.id });
  },
);
