/**
 * Build script — generates shadcn registry item JSONs from `src/`.
 *
 * Output:
 *   public/r/billing-stripe.json                 (big backend block)
 *   public/r/billing-ui.json                     (big UI block)
 *   public/r/billing-ui-<component>.json         (granular UI items)
 *   public/r/registry.json                       (served index)
 *
 * Run:
 *   pnpm tsx registry/scripts/build.ts
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REGISTRY_ROOT = resolve(__dirname, "..");
const SRC = join(REGISTRY_ROOT, "src");
const OUT = join(REGISTRY_ROOT, "public", "r");

mkdirSync(OUT, { recursive: true });

// ─── Helpers ─────────────────────────────────────────────────────────────────

type RegistryFile = {
  path: string;
  target: string;
  type: string;
  content: string;
};

type RegistryItem = {
  $schema: string;
  name: string;
  type: string;
  title: string;
  description: string;
  author?: string;
  homepage?: string;
  dependencies?: string[];
  devDependencies?: string[];
  registryDependencies?: string[];
  files: RegistryFile[];
};

const SCHEMA = "https://ui.shadcn.com/schema/registry-item.json";
const AUTHOR = "Parcae <https://github.com/EdenCoder/parcae>";
const HOMEPAGE = "https://github.com/EdenCoder/parcae";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, "utf-8");
}

function writeItem(item: RegistryItem) {
  const path = join(OUT, `${item.name}.json`);
  writeFileSync(path, JSON.stringify(item, null, 2) + "\n", "utf-8");
  console.log(
    `  → ${relative(REGISTRY_ROOT, path)} (${item.files.length} files)`,
  );
}

// ─── Target path mapping ─────────────────────────────────────────────────────
//
// Files under src/billing-stripe/ land in the consumer's API app. We use
// `~/` to mean "project root" (where the consumer's package.json is).
//
// Files under src/billing-ui/ land in the consumer's UI workspace. We use
// shadcn's alias-resolved targets so they honour the consumer's
// components.json (`components`, `lib`, `hooks`).

function backendTarget(srcPath: string): { target: string; type: string } {
  const rel = relative(join(SRC, "billing-stripe"), srcPath);
  // Models go under models/billing/ so they're grouped without colliding
  // with the consumer's other Models. Controllers, hooks, jobs keep their
  // `billing-*` filename prefix and live in their respective top-level
  // dirs where Parcae's auto-discovery finds them. Events (webhook
  // handlers) + lib helpers keep their source layout — they're never
  // discovered automatically and are only imported by the webhook
  // controller.
  if (rel.startsWith("models/")) {
    return {
      target: `~/models/billing/${rel.slice("models/".length)}`,
      type: "registry:file",
    };
  }
  return { target: `~/${rel}`, type: "registry:file" };
}

function uiTarget(srcPath: string): { target: string; type: string } {
  const rel = relative(join(SRC, "billing-ui"), srcPath);
  // components/**/*.tsx → registry:ui
  // hooks/**/*.ts → registry:hook
  // lib/**/*.ts → registry:lib
  if (rel.startsWith("components/"))
    return {
      target: `components/billing/${rel.slice("components/".length)}`,
      type: "registry:ui",
    };
  if (rel.startsWith("hooks/"))
    return {
      target: `hooks/billing/${rel.slice("hooks/".length)}`,
      type: "registry:hook",
    };
  if (rel.startsWith("lib/"))
    return {
      target: `lib/billing/${rel.slice("lib/".length)}`,
      type: "registry:lib",
    };
  return { target: rel, type: "registry:file" };
}

// ─── Backend block: billing-stripe ───────────────────────────────────────────

const backendFiles: RegistryFile[] = walk(join(SRC, "billing-stripe"))
  .filter(
    (p) =>
      p.endsWith(".ts") ||
      p.endsWith(".tsx") ||
      p.endsWith(".example") ||
      p.endsWith(".env.billing.example"),
  )
  .map((p) => {
    const { target, type } = backendTarget(p);
    return {
      path: relative(join(SRC, "billing-stripe"), p),
      target,
      type,
      content: read(p),
    };
  });

const billingStripe: RegistryItem = {
  $schema: SCHEMA,
  name: "billing-stripe",
  type: "registry:block",
  title: "Parcae · Stripe Billing",
  description:
    "Full Stripe billing backend for a Parcae app: 11 Models, 5 controllers, 5 hooks, 7 webhook event handlers, reconcile job, and lib helpers (stripe client, raw-body middleware, sync context). Bi-directional sync between local Models and Stripe.",
  author: AUTHOR,
  homepage: HOMEPAGE,
  dependencies: ["stripe"],
  files: backendFiles,
};

writeItem(billingStripe);

// ─── UI: one big block + per-component granular items ────────────────────────

const uiAllFiles: RegistryFile[] = walk(join(SRC, "billing-ui"))
  .filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"))
  .map((p) => {
    const { target, type } = uiTarget(p);
    return {
      path: relative(join(SRC, "billing-ui"), p),
      target,
      type,
      content: read(p),
    };
  });

// Common shadcn primitives we depend on. shadcn will install anything in
// this list that isn't already present in the consumer's UI package.
const BASE_DEPS = [
  "button",
  "badge",
  "card",
  "dialog",
  "input",
  "label",
  "radio-group",
  "separator",
  "table",
  "toggle",
  "tooltip",
];

// Shared UI deps (motion, class-variance-authority, lucide-react). These
// aren't shadcn components, so they go in npm `dependencies`.
const SHARED_NPM_DEPS = ["lucide-react", "motion", "class-variance-authority"];

const billingUi: RegistryItem = {
  $schema: SCHEMA,
  name: "billing-ui",
  type: "registry:block",
  title: "Parcae · Billing UI",
  description:
    "All Parcae billing UI in one shot: PricingTable, CheckoutButton, CustomerPortalButton, SubscriptionCard, InvoiceList, PaymentMethodList, UsageMeter, CancelDialog, UpdatePlanDialog, plus hooks (useBilling, useCurrentPlan) and transformers. Visuals forked from billingsdk.com.",
  author: AUTHOR,
  homepage: HOMEPAGE,
  dependencies: [...SHARED_NPM_DEPS, "@parcae/sdk"],
  registryDependencies: BASE_DEPS,
  files: uiAllFiles,
};

writeItem(billingUi);

// ─── Granular per-component items ────────────────────────────────────────────
//
// Each granular item ships exactly one component file + the minimum shared
// files it needs (transformers, hooks). Consumers who only want a pricing
// table don't have to install the whole UI kit.

const sharedLibPath = "lib/billing-transformers.ts";
const useBillingPath = "hooks/use-billing.ts";
const useCurrentPlanPath = "hooks/use-current-plan.ts";

function sharedFile(relPath: string): RegistryFile {
  const src = join(SRC, "billing-ui", relPath);
  const { target, type } = uiTarget(src);
  return {
    path: relPath,
    target,
    type,
    content: read(src),
  };
}

function componentFile(relPath: string): RegistryFile {
  const src = join(SRC, "billing-ui", relPath);
  const { target, type } = uiTarget(src);
  return {
    path: relPath,
    target,
    type,
    content: read(src),
  };
}

type GranularSpec = {
  name: string;
  title: string;
  description: string;
  componentRel: string; // e.g. "components/pricing-table.tsx"
  needsUseBilling?: boolean;
  needsUseCurrentPlan?: boolean;
  extraDeps?: string[];
  extraRegistryDeps?: string[];
};

const granular: GranularSpec[] = [
  {
    name: "billing-ui-pricing-table",
    title: "Parcae · PricingTable",
    description:
      "Plan comparison table that binds to your Product/Price Models. Monthly/yearly toggle, highlighted plan, animated entry.",
    componentRel: "components/pricing-table.tsx",
    needsUseBilling: true,
    extraRegistryDeps: ["button", "badge", "label", "radio-group", "separator"],
  },
  {
    name: "billing-ui-checkout-button",
    title: "Parcae · CheckoutButton",
    description:
      "Button that creates a Stripe Checkout Session and redirects. Works for subscriptions and one-time purchases.",
    componentRel: "components/checkout-button.tsx",
    needsUseBilling: true,
    extraRegistryDeps: ["button"],
  },
  {
    name: "billing-ui-customer-portal-button",
    title: "Parcae · CustomerPortalButton",
    description:
      "Button that opens the Stripe Customer Portal. Delegates card management, invoices, and cancellation to Stripe's hosted page.",
    componentRel: "components/customer-portal-button.tsx",
    needsUseBilling: true,
    extraRegistryDeps: ["button"],
  },
  {
    name: "billing-ui-subscription-card",
    title: "Parcae · SubscriptionCard",
    description:
      "Display the authenticated user's current subscription (plan, renewal date, payment method, status) with slottable actions.",
    componentRel: "components/subscription-card.tsx",
    needsUseBilling: true,
    extraRegistryDeps: ["card", "badge", "separator", "button"],
  },
  {
    name: "billing-ui-invoice-list",
    title: "Parcae · InvoiceList",
    description:
      "Paginated invoice history with status badges and download actions — binds to the Invoice model.",
    componentRel: "components/invoice-list.tsx",
    extraRegistryDeps: ["card", "table", "badge", "button"],
  },
  {
    name: "billing-ui-payment-method-list",
    title: "Parcae · PaymentMethodList",
    description:
      "Read-only list of saved payment methods. Adding/removing routes through the Stripe Customer Portal.",
    componentRel: "components/payment-method-list.tsx",
    needsUseBilling: true,
    extraRegistryDeps: ["card", "badge", "button"],
  },
  {
    name: "billing-ui-usage-meter",
    title: "Parcae · UsageMeter",
    description:
      "Horizontal progress meter for metered billing quotas. Optional color-by-saturation threshold styling.",
    componentRel: "components/usage-meter.tsx",
    extraRegistryDeps: ["card", "badge"],
  },
  {
    name: "billing-ui-cancel-dialog",
    title: "Parcae · CancelDialog",
    description:
      "Two-step cancellation dialog with retention offer. Forked and simplified from billingsdk's cancel-subscription-dialog.",
    componentRel: "components/cancel-dialog.tsx",
    extraRegistryDeps: ["dialog", "button", "badge"],
  },
  {
    name: "billing-ui-update-plan-dialog",
    title: "Parcae · UpdatePlanDialog",
    description:
      "Modal dialog for switching subscription plans with monthly/yearly toggle. Forked from billingsdk's update-plan-dialog.",
    componentRel: "components/update-plan-dialog.tsx",
    needsUseBilling: true,
    extraRegistryDeps: [
      "dialog",
      "button",
      "badge",
      "label",
      "radio-group",
      "toggle",
    ],
  },
];

for (const spec of granular) {
  const files: RegistryFile[] = [
    sharedFile(sharedLibPath),
    componentFile(spec.componentRel),
  ];
  if (spec.needsUseBilling) files.push(sharedFile(useBillingPath));
  if (spec.needsUseCurrentPlan) files.push(sharedFile(useCurrentPlanPath));

  const item: RegistryItem = {
    $schema: SCHEMA,
    name: spec.name,
    type: "registry:block",
    title: spec.title,
    description: spec.description,
    author: AUTHOR,
    homepage: HOMEPAGE,
    dependencies: [
      ...SHARED_NPM_DEPS,
      "@parcae/sdk",
      ...(spec.extraDeps ?? []),
    ],
    registryDependencies: [...(spec.extraRegistryDeps ?? BASE_DEPS)],
    files,
  };

  writeItem(item);
}

// ─── Served index ────────────────────────────────────────────────────────────

const index = {
  $schema: "https://ui.shadcn.com/schema/registry.json",
  name: "@parcae",
  homepage: HOMEPAGE,
  items: [
    {
      name: billingStripe.name,
      type: billingStripe.type,
      title: billingStripe.title,
    },
    { name: billingUi.name, type: billingUi.type, title: billingUi.title },
    ...granular.map((g) => ({
      name: g.name,
      type: "registry:block",
      title: g.title,
    })),
  ],
};
writeFileSync(
  join(OUT, "registry.json"),
  JSON.stringify(index, null, 2) + "\n",
);
console.log(`  → ${relative(REGISTRY_ROOT, join(OUT, "registry.json"))}`);

console.log(`\nBuilt ${granular.length + 2} registry items → ${OUT}`);
