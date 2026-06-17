import { notFound, route } from "@parcae/backend";
import type { RouteOptions } from "@parcae/backend";
import {
  detectLocale,
  resolveLocale,
  type LocaleDetectionOptions,
  type ParcaeI18nConfig,
} from "./index";

export const DEFAULT_I18N_ROUTE_PATH = "/v1/locale";

export interface I18nRoutesOptions extends LocaleDetectionOptions {
  /** Base path for locale catalogs. Default: /v1/locale. */
  path?: string;
  /** Route priority used by @parcae/backend. Default: 100. */
  priority?: RouteOptions["priority"];
  /** Cache-Control header for catalog responses. */
  cacheControl?: string;
}

export function registerI18nRoutes<TLocale extends string>(
  config: ParcaeI18nConfig<TLocale>,
  options: I18nRoutesOptions = {},
): void {
  const path = normalizeRoutePath(options.path ?? DEFAULT_I18N_ROUTE_PATH);
  const routeOptions: RouteOptions = { priority: options.priority ?? 100 };

  route.get(
    path,
    async (req: any, res: any) => {
      const resolution = req.i18nContext ?? detectLocale(req, config, options);

      await sendMessages(res, config, resolution.locale, options);
    },
    routeOptions,
  );

  route.get(
    joinRoutePath(path, ":locale"),
    async (req: any, res: any) => {
      const resolution = resolveLocale(readParam(req, "locale"), config);
      await sendMessages(res, config, resolution.locale, options);
    },
    routeOptions,
  );
}

async function sendMessages<TLocale extends string>(
  res: any,
  config: ParcaeI18nConfig<TLocale>,
  locale: TLocale,
  options: I18nRoutesOptions,
): Promise<void> {
  try {
    const messages = await config.loadMessages(locale);
    sendLocaleJson(res, locale, messages, options);
  } catch {
    notFound(res, "locale");
  }
}

function readParam(req: any, name: string): string {
  return String(req.params?.[name] ?? "").trim();
}

function sendLocaleJson(
  res: any,
  locale: string,
  body: unknown,
  options: I18nRoutesOptions,
): void {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control":
      options.cacheControl ??
      "public, max-age=300, stale-while-revalidate=86400",
    "Content-Language": locale,
  });
  res.end(JSON.stringify(body));
}

function normalizeRoutePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return DEFAULT_I18N_ROUTE_PATH;
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.replace(/\/+$/, "") || "/";
}

function joinRoutePath(path: string, child: string): string {
  return path === "/" ? `/${child}` : `${path}/${child}`;
}
