import { describe, expect, it } from "vitest";
import {
  createI18nSync,
  defineI18n,
  detectLocale,
  parseAcceptLanguage,
  resolveLocale,
} from "../index";

const config = defineI18n({
  locales: ["en", "fr", "pt-BR"] as const,
  defaultLocale: "en",
  loadMessages: (locale) => ({
    greeting: locale === "fr" ? "Bonjour" : "Hello",
  }),
});

describe("@parcae/i18n locale negotiation", () => {
  it("sorts Accept-Language candidates by q value", () => {
    expect(parseAcceptLanguage("en-AU,en;q=0.6,fr;q=0.9")).toEqual([
      "en-AU",
      "fr",
      "en",
    ]);
  });

  it("matches exact configured locales first", () => {
    expect(resolveLocale("pt-BR", config)).toMatchObject({
      locale: "pt-BR",
      match: "exact",
    });
  });

  it("falls back from region variants to language matches", () => {
    expect(resolveLocale("fr-CA", config)).toMatchObject({
      locale: "fr",
      requestedLocale: "fr-CA",
      match: "language",
    });
  });

  it("detects query locale before cookies and headers", () => {
    expect(
      detectLocale(
        {
          url: "/settings?locale=fr",
          headers: {
            cookie: "locale=pt-BR",
            "accept-language": "en-AU,en;q=0.8",
          },
        },
        config,
      ),
    ).toMatchObject({
      locale: "fr",
      source: "query",
    });
  });

  it("creates a synchronous Lingui instance for static catalogs", () => {
    const ctx = createI18nSync(config, "fr");

    expect(ctx.locale).toBe("fr");
    expect(ctx.i18n.locale).toBe("fr");
  });
});
