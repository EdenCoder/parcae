/**
 * Push local Customer changes to Stripe.
 *
 * This typically runs when app code calls `customer.save()` to update
 * email, name, phone, address, or default payment method. Skipped when
 * inside a sync context.
 */
import { hook } from "@parcae/backend";
import { log } from "@parcae/backend";
import { Customer } from "../models/billing/Customer";
import { stripe } from "../lib/stripe";
import { isInSyncContext, runInSyncContext } from "../lib/sync-context";

hook.after(Customer, "save", async ({ model }: any) => {
  if (isInSyncContext()) return;

  const customer = model as any;
  const s = stripe();

  try {
    const payload: any = {
      email: customer.email || undefined,
      name: customer.name || undefined,
      phone: customer.phone || undefined,
      address: customer.address?.line1 ? customer.address : undefined,
      metadata: customer.metadata ?? {},
    };

    if (customer.defaultPaymentMethod) {
      payload.invoice_settings = {
        default_payment_method: customer.defaultPaymentMethod,
      };
    }

    if (customer.stripeCustomerId) {
      await s.customers.update(customer.stripeCustomerId, payload);
      log.info(
        `[billing] Customer pushed → Stripe ${customer.stripeCustomerId}`,
      );
    } else {
      const created = await s.customers.create({
        ...payload,
        metadata: { ...payload.metadata, user: customer.user },
      });
      await runInSyncContext("push:customer", async () => {
        customer.stripeCustomerId = created.id;
        customer.lastSyncedAt = new Date();
        await customer.save();
      });
      log.info(`[billing] Customer created in Stripe: ${created.id}`);
    }
  } catch (err: any) {
    log.error(
      `[billing] Failed to push Customer ${customer.id} to Stripe: ${err.message}`,
    );
  }
});
