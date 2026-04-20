/**
 * POST /v1/billing/webhook
 *
 * Stripe webhook receiver. Verifies the signature, parses the event, and
 * dispatches to event handlers. Replies 200 to ACK receipt — Stripe retries
 * on 4xx/5xx/timeouts.
 *
 * Registered at `priority: 1` so it runs before any global JSON body parser
 * — webhook signature verification requires the raw request body.
 */
import { route, json, error as errorRes } from "@parcae/backend";
import { log } from "@parcae/backend";
import type Stripe from "stripe";
import { stripe } from "../lib/stripe";
import { captureRawBody, resolveRawBody } from "../lib/raw-body";
import { dispatchStripeEvent } from "../events";

route.post(
  "/v1/billing/webhook",
  captureRawBody,
  async (req: any, res: any) => {
    const sig = req.headers["stripe-signature"] as string | undefined;
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    const skipVerify = process.env.STRIPE_SKIP_SIGNATURE_VERIFY === "1";

    if (!secret && !skipVerify) {
      log.error(
        "[billing/webhook] STRIPE_WEBHOOK_SECRET is not set. Set it or STRIPE_SKIP_SIGNATURE_VERIFY=1 for local dev.",
      );
      errorRes(res, 500, "Webhook secret not configured");
      return;
    }

    let event: Stripe.Event;
    try {
      if (skipVerify) {
        // Dev-only path — parse whatever body we have
        event = (req.body ??
          JSON.parse(await resolveRawBody(req))) as Stripe.Event;
      } else {
        if (!sig) {
          log.warn("[billing/webhook] Missing stripe-signature header");
          errorRes(res, 400, "Missing stripe-signature header");
          return;
        }
        const raw = await resolveRawBody(req);
        event = stripe().webhooks.constructEvent(raw, sig, secret!);
      }
    } catch (err: any) {
      log.warn(
        `[billing/webhook] Signature verification failed: ${err.message}`,
      );
      errorRes(
        res,
        400,
        `Webhook signature verification failed: ${err.message}`,
      );
      return;
    }

    // ACK immediately in parallel with dispatch (Stripe wants fast 200s).
    // We still await dispatch because Parcae's socket-RPC bridge needs end()
    // to fire to send the response. For high-volume webhooks consider
    // enqueuing dispatch into a BullMQ job instead of awaiting here.
    try {
      await dispatchStripeEvent(event);
    } catch (err: any) {
      // We already logged inside dispatch. Return 500 so Stripe retries.
      errorRes(res, 500, "Event dispatch failed");
      return;
    }

    json(res, 200, { received: true, id: event.id });
  },
  { priority: 1 },
);
