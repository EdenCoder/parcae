import { afterEach, describe, expect, it } from "vitest";
import { clearRoutes, getRoutes } from "@parcae/backend";
import { defineI18n } from "../index";
import { DEFAULT_I18N_ROUTE_PATH, registerI18nRoutes } from "../backend";

const config = defineI18n({
  locales: ["en", "fr"] as const,
  defaultLocale: "en",
  loadMessages: (locale) => ({
    greeting: locale === "fr" ? "Bonjour" : "Hello",
  }),
});

afterEach(() => {
  clearRoutes();
});

describe("@parcae/i18n backend routes", () => {
  it("registers the default locale catalog routes", () => {
    registerI18nRoutes(config);

    expect(getRoutes().map((entry) => entry.path)).toEqual([
      DEFAULT_I18N_ROUTE_PATH,
      `${DEFAULT_I18N_ROUTE_PATH}/:locale`,
    ]);
  });

  it("allows an optional custom route path", () => {
    registerI18nRoutes(config, { path: "api/messages" });

    expect(getRoutes().map((entry) => entry.path)).toEqual([
      "/api/messages",
      "/api/messages/:locale",
    ]);
  });

  it("allows the root path when explicitly configured", () => {
    registerI18nRoutes(config, { path: "/" });

    expect(getRoutes().map((entry) => entry.path)).toEqual(["/", "/:locale"]);
  });

  it("serves flattened Lingui messages for a resolved locale", async () => {
    registerI18nRoutes(config);
    const route = getRoutes().find(
      (entry) => entry.path === `${DEFAULT_I18N_ROUTE_PATH}/:locale`,
    );
    const response = createResponse();

    await route?.handler({ params: { locale: "fr-CA" } }, response.res);

    expect(response.status()).toBe(200);
    expect(response.header("Content-Language")).toBe("fr");
    expect(response.json()).toEqual({ greeting: "Bonjour" });
  });

  it("detects the default route locale from the request", async () => {
    registerI18nRoutes(config);
    const route = getRoutes().find(
      (entry) => entry.path === DEFAULT_I18N_ROUTE_PATH,
    );
    const response = createResponse();

    await route?.handler(
      { url: "/v1/locale?locale=fr", headers: {} },
      response.res,
    );

    expect(response.status()).toBe(200);
    expect(response.header("Content-Language")).toBe("fr");
    expect(response.json()).toEqual({ greeting: "Bonjour" });
  });
});

function createResponse() {
  let status = 0;
  let body = "";
  const headers: Record<string, string> = {};

  return {
    res: {
      writeHead(code: number, nextHeaders: Record<string, string>) {
        status = code;
        Object.assign(headers, nextHeaders);
      },
      end(nextBody: string) {
        body = nextBody;
      },
    },
    status: () => status,
    header: (name: string) => headers[name],
    json: () => JSON.parse(body) as unknown,
  };
}
