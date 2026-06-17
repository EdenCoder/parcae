# @parcae/i18n

Lingui-powered i18n helpers for Parcae apps.

This package deliberately does not make `@parcae/backend`, `@parcae/sdk`, or
`@parcae/model` depend on translations. Apps opt in at their frontend or
backend boundary.

## Install

```bash
pnpm add @parcae/i18n @lingui/core

# Frontend React apps also need:
pnpm add @lingui/react

# Apps that use Lingui macros need dev tooling:
pnpm add -D @lingui/cli @lingui/swc-plugin
```

Use Babel or Vite Lingui tooling instead of `@lingui/swc-plugin` if that is
what your frontend already uses.

## Shared config

```ts
// i18n.ts
import { defineI18n } from "@parcae/i18n";

export const i18nConfig = defineI18n({
  sourceLocale: "en",
  defaultLocale: "en",
  locales: ["en", "fr", "ja"] as const,
  loadMessages: async (locale) => {
    const catalog = await import(`./locales/${locale}/messages.js`);
    return catalog.messages;
  },
});
```

The package does not prescribe where catalogs live. Use compiled Lingui
catalogs from `lingui compile`, static imports, or framework-specific dynamic
imports.

## Backend

Attach request-local Lingui state with middleware and register the default
catalog routes:

```ts
import { createApp, route, ok } from "@parcae/backend";
import { createI18nMiddleware } from "@parcae/i18n";
import { registerI18nRoutes } from "@parcae/i18n/backend";
import { i18nConfig } from "./i18n";

registerI18nRoutes(i18nConfig);

route.get("/v1/greeting", (req, res) => {
  ok(res, {
    greeting: req.i18n._({
      id: "api.greeting",
      message: "Hello",
    }),
  });
});

createApp({
  models: [],
  middleware: [createI18nMiddleware(i18nConfig)],
});
```

`registerI18nRoutes()` serves flattened Lingui messages at:

```txt
GET /v1/locale
GET /v1/locale/:locale
```

Pass `{ path: "/api/messages" }` only when an app needs a non-standard
endpoint.

For route-local usage without middleware:

```ts
import { withI18n } from "@parcae/i18n";

route.get("/v1/greeting", async (req, res) => {
  const body = await withI18n(req, i18nConfig, ({ i18n, locale }) => ({
    locale,
    greeting: i18n._({ id: "api.greeting", message: "Hello" }),
  }));
  ok(res, body);
});
```

Locale detection checks, in order:

1. `req.locale` or `req.language`
2. `?locale=...`
3. `locale` cookie
4. `x-locale` header
5. `Accept-Language`
6. `defaultLocale`

The names are configurable on `detectLocale`, `withI18n`, and
`createI18nMiddleware`.

## React

```tsx
"use client";

import { ParcaeI18nProvider } from "@parcae/i18n/react";
import { i18nConfig } from "./i18n";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ParcaeI18nProvider config={i18nConfig} initialLocale="en">
      {children}
    </ParcaeI18nProvider>
  );
}
```

Use Lingui macros in app code:

```tsx
import { Trans, useLingui } from "@lingui/react/macro";
import { useLocale } from "@parcae/i18n/react";

export function LocaleSwitcher() {
  const [locale, setLocale] = useLocale<"en" | "fr" | "ja">();
  const { t } = useLingui();

  return (
    <button onClick={() => setLocale(locale === "en" ? "fr" : "en")}>
      <Trans>Current locale: {locale}</Trans>
      <span className="sr-only">{t`Change language`}</span>
    </button>
  );
}
```

## Lingui config

Each app still owns its Lingui extraction settings:

```ts
// lingui.config.ts
import { defineConfig } from "@lingui/cli";

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "fr", "ja"],
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["src"],
    },
  ],
});
```

In monorepos, put a shared Lingui config at the root and extend it per app
when catalogs should be split by package or deployment unit.
