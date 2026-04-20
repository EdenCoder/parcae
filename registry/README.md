# @parcae Registry

Shadcn-compatible registry for Parcae plugins. Today it ships one plugin —
**Stripe billing** — with both a backend block (Models, controllers, hooks,
jobs, lib) and a UI block (Parcae-wired React components forked from
[billingsdk.com](https://billingsdk.com)).

Everything is installed by copying files into your project. You own the
code. No runtime dependency on a hosted service. Edit, delete, or rewrite
any generated file.

---

## Install

### 1. Add the registry to your `components.json`

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "registries": {
    "@parcae": "https://raw.githubusercontent.com/EdenCoder/parcae/master/registry/public/r/{name}.json"
  }
}
```

You can pin to a specific git SHA/tag for reproducibility — replace `master`
with the SHA/tag in the URL.

### 2. Install the backend block

From your API app's root (where `package.json` with `@parcae/backend`
lives — e.g. `apps/api.dollhouse.studio/`):

```bash
npx shadcn@latest add @parcae/billing-stripe
```

This copies 36 files into your project:

- `models/billing/*.ts` — 11 Models (Product, Price, Customer, Subscription, SubscriptionItem, Invoice, PaymentMethod, Coupon, PromotionCode, Meter, UsageRecord)
- `controllers/*.ts` — 5 controllers (checkout, portal, subscription, usage, webhook)
- `events/*.ts` — 7 Stripe webhook event handlers + dispatcher
- `hooks/*.ts` — 5 outbound push hooks + a credit-grant stub
- `jobs/billing-reconcile.ts` — safety-net daily sync
- `lib/*.ts` — Stripe client, raw-body middleware, sync context, sync helpers

It also adds `stripe` to your `package.json` dependencies.

### 3. Install the UI block (all-in-one or per component)

From your UI workspace (e.g. `packages/ui/`):

```bash
# Everything
npx shadcn@latest add @parcae/billing-ui

# Or individual components
npx shadcn@latest add @parcae/billing-ui-pricing-table
npx shadcn@latest add @parcae/billing-ui-subscription-card
npx shadcn@latest add @parcae/billing-ui-invoice-list
# …see `registry/public/r/` for the full list.
```

Granular items share `lib/billing/billing-transformers.ts` + `hooks/billing/*`
so you can mix and match.

### 4. Configure environment

Add to your API app's `.env`:

```ini
# Required
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Optional — overrides for checkout/portal redirect URLs
FRONTEND_URL=https://app.example.com
STRIPE_SUCCESS_URL=https://app.example.com/settings/billing?success=1
STRIPE_CANCEL_URL=https://app.example.com/settings/billing?cancel=1
STRIPE_PORTAL_RETURN_URL=https://app.example.com/settings/billing

# Dev only — skip signature verification when testing locally without Stripe CLI
# STRIPE_SKIP_SIGNATURE_VERIFY=1
```

### 5. Register the Models

Parcae only auto-migrates Models that are passed to `createApp`. Merge
`BILLING_MODELS` into your model list:

```ts
// index.ts
import { createApp } from "@parcae/backend";
import { ALL_MODELS } from "@dollhousestudio/models"; // or your equivalent
import { BILLING_MODELS } from "./models/billing";

const app = createApp({
  models: [...ALL_MODELS, ...BILLING_MODELS],
  controllers: "./controllers",
  hooks: "./hooks",
  jobs: "./jobs",
  auth: betterAuth({
    /* ... */
  }),
});
```

Then run the additive schema migration once:

```bash
ENSURE_SCHEMA=true pnpm tsx index.ts
```

### 6. Configure the Stripe webhook

In the [Stripe Dashboard](https://dashboard.stripe.com/webhooks):

- Endpoint URL: `https://api.yourapp.com/v1/billing/webhook`
- Events to send: select **All events** (or at minimum: `product.*`,
  `price.*`, `customer.*`, `customer.subscription.*`, `invoice.*`,
  `checkout.session.*`, `payment_method.*`, `coupon.*`, `promotion_code.*`)
- Copy the **Signing secret** into `STRIPE_WEBHOOK_SECRET`

For local development, use the Stripe CLI:

```bash
stripe listen --forward-to localhost:3000/v1/billing/webhook
```

---

## How it works

### Bi-directional sync

Products, Prices, Customers, and Subscriptions sync **both ways**:

- **Stripe → Local (inbound)**: Stripe webhooks call into `events/*.ts`,
  which invoke `lib/sync.ts` helpers. Each upsert runs inside
  `runInSyncContext(...)` so the outbound-push hooks short-circuit.
- **Local → Stripe (outbound)**: `hook.after(Product, "save")` and friends
  push mutations back to Stripe via the Stripe SDK. They check
  `isInSyncContext()` first and no-op during webhook processing.

The **sync context** is an `AsyncLocalStorage` flag that scopes one
direction of sync per request/webhook. No echo loops; no "who changed
this first?" guesswork.

### Webhook signature verification

Stripe signs the raw request body. The generated `controllers/billing-webhook.ts`
registers at `priority: 1` with a `captureRawBody` middleware that reads the
stream before any global JSON body-parser runs. If the raw body has already
been consumed (depends on your Parcae setup), we fall back to reconstructing
it via `JSON.stringify(req.body)` — Stripe accepts this in practice for
well-formed payloads. Set `STRIPE_WEBHOOK_ALLOW_RECONSTRUCTED=false` to
require strict byte-exact bodies.

### Realtime

Once the backend is installed, the UI components "just work" in realtime.
Webhook handlers upsert local Models; Parcae's `QuerySubscriptionManager`
pushes diffs to any `useQuery` subscription via Socket.IO. A subscription
going `past_due` on Stripe reaches your UI within a second.

### Credit ledger integration

`hooks/billing-credit-grant.ts` is a stub. Wire it up to your token /
credit ledger (e.g. Dollhouse's `Credit` model) to grant tokens on paid
invoices. The convention:

1. Set `metadata.grant_credits: "1000"` on your Stripe Product
2. Edit `hooks/billing-credit-grant.ts` to read that metadata + write a
   `Credit` row when `invoice.status === "paid"` fires

See the TODO comment in the generated file.

---

## Routes installed

| Method | Path                              | Purpose                              |
| ------ | --------------------------------- | ------------------------------------ |
| POST   | `/v1/billing/checkout`            | Create Stripe Checkout Session       |
| POST   | `/v1/billing/portal`              | Create Customer Portal Session       |
| POST   | `/v1/billing/subscription/cancel` | Cancel (at period end or immediate)  |
| POST   | `/v1/billing/subscription/resume` | Un-cancel a pending cancellation     |
| POST   | `/v1/billing/subscription/change` | Upgrade / downgrade to another Price |
| POST   | `/v1/billing/usage`               | Report a metered billing event       |
| POST   | `/v1/billing/webhook`             | Stripe webhook receiver              |

Plus Parcae's auto-CRUD for each Model (GET `/v1/products`, etc.). Product
and Price auto-CRUD is read-only; writes come from webhooks or your admin code.

---

## UI components

All components are forked from [billingsdk.com](https://billingsdk.com)
(MIT), theme-context dependencies stripped, adapted to use your project's
default shadcn tokens.

| Component                  | Binds to                                      |
| -------------------------- | --------------------------------------------- |
| `<PricingTable />`         | `useQuery(Product.where({ active: true }))`   |
| `<CheckoutButton />`       | `useBilling().openCheckout`                   |
| `<CustomerPortalButton />` | `useBilling().openPortal`                     |
| `<SubscriptionCard />`     | `useCurrentPlan()`                            |
| `<InvoiceList />`          | `useQuery(Invoice.where({ user: me }))`       |
| `<PaymentMethodList />`    | `useQuery(PaymentMethod.where({ user: me }))` |
| `<UsageMeter />`           | Your own metered quotas                       |
| `<CancelDialog />`         | `useBilling().cancel`                         |
| `<UpdatePlanDialog />`     | `useBilling().changePlan`                     |

---

## Example — a complete settings page

```tsx
"use client";
import { useQuery } from "@parcae/sdk/react";
import {
  Product,
  Price,
  Invoice,
  Subscription,
  SubscriptionItem,
  PaymentMethod,
} from "@dollhousestudio/models";
import { PricingTable } from "@/components/billing/pricing-table";
import { SubscriptionCard } from "@/components/billing/subscription-card";
import { InvoiceList } from "@/components/billing/invoice-list";
import { CustomerPortalButton } from "@/components/billing/customer-portal-button";
import { useCurrentPlan } from "@/hooks/billing/use-current-plan";
import { useBilling } from "@/hooks/billing/use-billing";
import {
  productsToPlans,
  invoiceToItem,
} from "@/lib/billing/billing-transformers";

export default function BillingPage() {
  const { items: products } = useQuery(Product.where({ active: true }));
  const { items: prices } = useQuery(Price.where({ active: true }));
  const { items: invoices } = useQuery(Invoice.orderBy("createdAt", "desc"));

  const { currentPlan } = useCurrentPlan({
    Subscription,
    SubscriptionItem,
    Price,
    Product,
    PaymentMethod,
  });

  const plans = productsToPlans(products, prices);
  const { openCheckout } = useBilling();

  return (
    <div className="flex flex-col gap-6">
      {currentPlan ? (
        <SubscriptionCard currentPlan={currentPlan} />
      ) : (
        <PricingTable
          plans={plans}
          onPlanSelect={(plan, interval) =>
            openCheckout({
              price:
                interval === "yearly"
                  ? plan._yearlyPriceId
                  : plan._monthlyPriceId,
            })
          }
        />
      )}

      <InvoiceList invoices={invoices.map(invoiceToItem)} />

      <div className="flex justify-end">
        <CustomerPortalButton />
      </div>
    </div>
  );
}
```

---

## Developing the registry

```bash
# Edit src/billing-stripe/... or src/billing-ui/...
pnpm --filter parcae build:registry
# → regenerates public/r/*.json
```

Commit the regenerated `public/r/*.json` — consumers fetch them via GitHub
raw URLs, so they must be up to date on the committed branch.

### Conventions

- Backend files target `~/...` (the consumer's project root). Copied files
  preserve their relative structure (`models/`, `controllers/`, `lib/`,
  `events/`, `hooks/`, `jobs/`).
- UI files use shadcn aliases: `components/billing/...`, `hooks/billing/...`,
  `lib/billing/...`. The `billing/` prefix keeps them organized without
  conflicting with the consumer's other UI.
- Every Model has a `lastSyncedAt` field and `stripe<Type>Id` for round-trip.

---

## License

MIT — same as Parcae. Billingsdk component derivatives retain their MIT
provenance (attributed in each file's header comment).
