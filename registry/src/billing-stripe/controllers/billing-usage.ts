/**
 * POST /v1/billing/usage
 *
 * Report usage events against a Stripe Meter (metered billing). The body
 * payload mirrors Stripe's Meter Events shape; we wrap it with auth +
 * customer resolution + local UsageRecord persistence for audit trails.
 *
 *   body: { meter: "mtr_...", quantity: 1, timestamp?: iso, idempotencyKey?: string, payload?: {...} }
 */
import { route, ok, badRequest } from "@parcae/backend";
import { stripe } from "../lib/stripe";
import { requireBillingAuth } from "../lib/auth";
import { Customer } from "../models/billing/Customer";
import { Meter } from "../models/billing/Meter";
import { UsageRecord } from "../models/billing/UsageRecord";

interface UsageBody {
  /** Meter event name (e.g. "api_request") — matches Meter.eventName. */
  event: string;
  /** Quantity to report. */
  quantity: number;
  /** Unix timestamp (seconds). Defaults to now. */
  timestamp?: number;
  /** Idempotency key — stable string so duplicates are rejected by Stripe. */
  idempotencyKey?: string;
  /** Any extra payload Stripe should receive on the meter event. */
  payload?: Record<string, any>;
}

route.post(
  "/v1/billing/usage",
  requireBillingAuth,
  async (req: any, res: any) => {
    const body = (req.body ?? {}) as UsageBody;
    const userId: string = req.userId;

    if (!body.event || typeof body.quantity !== "number") {
      badRequest(res, "Must provide `event` and numeric `quantity`");
      return;
    }

    const customer = await (Customer as any).where({ user: userId }).first();
    if (!customer?.stripeCustomerId) {
      badRequest(res, "User has no Stripe customer");
      return;
    }

    const meter = await (Meter as any).where({ eventName: body.event }).first();
    if (!meter) {
      badRequest(res, `Unknown meter event: ${body.event}`);
      return;
    }

    const ts = body.timestamp ?? Math.floor(Date.now() / 1000);

    // Send to Stripe — Meter Events API
    const s = stripe();
    await (s as any).billing.meterEvents.create(
      {
        event_name: body.event,
        timestamp: ts,
        payload: {
          value: String(body.quantity),
          stripe_customer_id: customer.stripeCustomerId,
          ...(body.payload ?? {}),
        },
        ...(body.idempotencyKey && { identifier: body.idempotencyKey }),
      },
      body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : undefined,
    );

    // Record locally for audit/dashboard
    const record = (UsageRecord as any).create({
      user: userId,
      meter: meter.id,
      quantity: body.quantity,
      timestamp: new Date(ts * 1000),
      idempotencyKey: body.idempotencyKey ?? "",
      action: "increment",
    });
    await record.save();

    ok(res, { recorded: true });
  },
);
