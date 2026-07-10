import { describe, expect, it } from "vitest";
import { setupI18n } from "@lingui/core";
import {
  activateLocaleIfCurrent,
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

describe("React locale activation", () => {
  it("does not let a stale catalog load win", async () => {
    const en = deferred<Record<string, string>>();
    const fr = deferred<Record<string, string>>();
    const controlledConfig = defineI18n({
      locales: ["en", "fr"] as const,
      defaultLocale: "en",
      loadMessages: (locale) => locale === "en" ? en.promise : fr.promise,
    });
    const i18n = setupI18n();
    let generation = 0;
    const activate = (locale: "en" | "fr") => {
      const current = ++generation;
      return activateLocaleIfCurrent(
        i18n,
        controlledConfig,
        locale,
        () => current === generation,
      );
    };

    const stale = activate("en");
    const current = activate("fr");
    fr.resolve({ greeting: "Bonjour" });
    await current;
    en.resolve({ greeting: "Hello" });
    await stale;

    expect(i18n.locale).toBe("fr");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

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
