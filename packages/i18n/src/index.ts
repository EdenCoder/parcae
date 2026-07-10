import { setupI18n } from "@lingui/core";
import type { I18n, Locales, Messages } from "@lingui/core";
import {
  detectLocale,
  resolveLocale,
  type LocaleDetectionOptions,
  type LocaleResolution,
  type MaybePromise,
  type ParcaeI18nConfig,
  type RequestLocaleInput,
} from "./locale";

export * from "./locale";

export interface ParcaeI18nContext<TLocale extends string = string>
  extends LocaleResolution<TLocale> {
  i18n: I18n;
}

export interface I18nMiddlewareOptions extends LocaleDetectionOptions {
  /** Set `Content-Language` on HTTP responses. Default: true. */
  contentLanguage?: boolean;
  /** Assign the context to `req.i18nContext`. Default: true. */
  assignContext?: boolean;
}

export async function createI18n<TLocale extends string>(
  config: ParcaeI18nConfig<TLocale>,
  requestedLocale?: string | null,
): Promise<ParcaeI18nContext<TLocale>> {
  const resolution = resolveLocale(requestedLocale, config);
  const i18n = setupI18n({ missing: config.missing });
  await activateLocale(i18n, config, resolution.locale);
  return { ...resolution, i18n };
}

export function createI18nSync<TLocale extends string>(
  config: ParcaeI18nConfig<TLocale>,
  requestedLocale?: string | null,
): ParcaeI18nContext<TLocale> {
  const resolution = resolveLocale(requestedLocale, config);
  const i18n = setupI18n({ missing: config.missing });
  activateLocaleSync(i18n, config, resolution.locale);
  return { ...resolution, i18n };
}

export async function activateLocale<TLocale extends string>(
  i18n: I18n,
  config: ParcaeI18nConfig<TLocale>,
  locale: TLocale,
): Promise<void> {
  await activateLocaleIfCurrent(i18n, config, locale, () => true);
}

/** @internal React cancellation boundary: stale loads never activate. */
export async function activateLocaleIfCurrent<TLocale extends string>(
  i18n: I18n,
  config: ParcaeI18nConfig<TLocale>,
  locale: TLocale,
  isCurrent: () => boolean,
): Promise<boolean> {
  const messages = await config.loadMessages(locale);
  if (!isCurrent()) return false;
  i18n.loadAndActivate({
    locale,
    locales: getFormatLocales(config, locale),
    messages,
  });
  return true;
}

export function activateLocaleSync<TLocale extends string>(
  i18n: I18n,
  config: ParcaeI18nConfig<TLocale>,
  locale: TLocale,
): void {
  const messages = config.loadMessages(locale);
  if (isPromiseLike(messages)) {
    throw new Error(
      "@parcae/i18n createI18nSync requires a synchronous loadMessages function",
    );
  }
  i18n.loadAndActivate({
    locale,
    locales: getFormatLocales(config, locale),
    messages,
  });
}

export function getFormatLocales<TLocale extends string>(
  config: ParcaeI18nConfig<TLocale>,
  locale: TLocale,
): Locales {
  const locales = [locale];
  if (config.fallbackLocale && config.fallbackLocale !== locale) {
    locales.push(config.fallbackLocale);
  }
  if (
    config.defaultLocale !== locale &&
    config.defaultLocale !== config.fallbackLocale
  ) {
    locales.push(config.defaultLocale);
  }
  return locales;
}

export function formatDate(
  locale: string | string[],
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
  },
): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(locale, options).format(date);
}

export function formatNumber(
  locale: string | string[],
  value: number | bigint,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function createI18nMiddleware<TLocale extends string>(
  config: ParcaeI18nConfig<TLocale>,
  options: I18nMiddlewareOptions = {},
) {
  const contentLanguage = options.contentLanguage ?? true;
  const assignContext = options.assignContext ?? true;

  return async function parcaeI18nMiddleware(
    req: any,
    res: any,
    next: (err?: unknown) => void,
  ): Promise<void> {
    try {
      const resolution = detectLocale(req, config, options);
      const i18n = setupI18n({ missing: config.missing });
      await activateLocale(i18n, config, resolution.locale);

      const context: ParcaeI18nContext<TLocale> = { ...resolution, i18n };
      req.locale = resolution.locale;
      req.i18n = i18n;
      if (assignContext) req.i18nContext = context;

      if (res?.locals) {
        res.locals.locale = resolution.locale;
        res.locals.i18n = i18n;
        if (assignContext) res.locals.i18nContext = context;
      }

      if (contentLanguage && typeof res?.setHeader === "function") {
        res.setHeader("Content-Language", resolution.locale);
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

export async function withI18n<TLocale extends string, TResult>(
  input: RequestLocaleInput,
  config: ParcaeI18nConfig<TLocale>,
  handler: (ctx: ParcaeI18nContext<TLocale>) => MaybePromise<TResult>,
  options?: LocaleDetectionOptions,
): Promise<TResult> {
  const resolution = detectLocale(input, config, options);
  const i18n = setupI18n({ missing: config.missing });
  await activateLocale(i18n, config, resolution.locale);
  return handler({ ...resolution, i18n });
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as Promise<T>).then === "function",
  );
}

export type { I18n, Messages };
