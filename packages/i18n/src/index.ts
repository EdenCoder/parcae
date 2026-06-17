import { setupI18n } from "@lingui/core";
import type { I18n, Locales, Messages } from "@lingui/core";

export type MaybePromise<T> = T | Promise<T>;

export interface ParcaeI18nConfig<TLocale extends string = string> {
  /** Supported BCP 47 locale tags. */
  locales: readonly TLocale[];
  /** Locale used when no supported request/browser locale is found. */
  defaultLocale: TLocale;
  /** Locale used by source messages in app code. */
  sourceLocale?: TLocale;
  /** Optional explicit fallback before defaultLocale. */
  fallbackLocale?: TLocale;
  /** Load a compiled Lingui catalog for the requested locale. */
  loadMessages: (locale: TLocale) => MaybePromise<Messages>;
  /** Lingui missing-message behavior. */
  missing?: string | ((locale: string, id: string) => string);
}

export type LocaleMatch = "exact" | "language" | "fallback";

export type LocaleSource =
  | "explicit"
  | "query"
  | "cookie"
  | "header"
  | "accept-language"
  | "default";

export interface LocaleResolution<TLocale extends string = string> {
  locale: TLocale;
  requestedLocale: string | null;
  source: LocaleSource;
  match: LocaleMatch;
}

export interface LocaleDetectionOptions {
  /** Query parameter to read, for example `?locale=fr`. Default: locale. */
  queryParam?: string;
  /** Cookie to read. Default: locale. */
  cookieName?: string;
  /** Direct locale header to read before Accept-Language. Default: x-locale. */
  headerName?: string;
  /** Accept-Language header name. Default: accept-language. */
  acceptLanguageHeader?: string;
}

export interface RequestLocaleInput {
  locale?: string | null;
  language?: string | null;
  url?: string;
  query?: Record<string, unknown>;
  cookies?: CookieInput;
  headers?: HeaderInput;
}

export type HeaderInput =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null | undefined };

export type CookieInput =
  | string
  | Record<string, string | undefined>
  | { get(name: string): string | { value?: string } | null | undefined };

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

const DEFAULT_DETECTION: Required<LocaleDetectionOptions> = {
  queryParam: "locale",
  cookieName: "locale",
  headerName: "x-locale",
  acceptLanguageHeader: "accept-language",
};

export function defineI18n<TLocale extends string>(
  config: ParcaeI18nConfig<TLocale>,
): ParcaeI18nConfig<TLocale> {
  assertI18nConfig(config);
  return config;
}

export function assertI18nConfig<TLocale extends string>(
  config: ParcaeI18nConfig<TLocale>,
): void {
  if (!config.locales.length) {
    throw new Error("@parcae/i18n requires at least one locale");
  }
  if (!config.locales.includes(config.defaultLocale)) {
    throw new Error(
      `@parcae/i18n defaultLocale "${config.defaultLocale}" is not in locales`,
    );
  }
  if (config.fallbackLocale && !config.locales.includes(config.fallbackLocale)) {
    throw new Error(
      `@parcae/i18n fallbackLocale "${config.fallbackLocale}" is not in locales`,
    );
  }
}

export function normalizeLocale(locale: string): string {
  const cleaned = locale.trim().replace(/_/g, "-");
  if (!cleaned) return cleaned;
  try {
    return Intl.getCanonicalLocales(cleaned)[0] ?? cleaned;
  } catch {
    return cleaned;
  }
}

export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];

  return header
    .split(",")
    .map((part, index) => {
      const [rawTag, ...params] = part.trim().split(";");
      const locale = sanitizeLocale(rawTag);
      const qParam = params
        .map((p) => p.trim())
        .find((p) => p.toLowerCase().startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
      return {
        locale,
        index,
        q: Number.isFinite(q) ? q : 0,
      };
    })
    .filter((entry): entry is { locale: string; index: number; q: number } =>
      Boolean(entry.locale && entry.q > 0),
    )
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((entry) => entry.locale);
}

export function resolveLocale<TLocale extends string>(
  requested: string | readonly (string | null | undefined)[] | null | undefined,
  config: ParcaeI18nConfig<TLocale>,
): LocaleResolution<TLocale> {
  assertI18nConfig(config);
  const candidates = toLocaleCandidates(requested);

  for (const candidate of candidates) {
    const match = matchLocale(candidate, config);
    if (match) {
      return {
        locale: match.locale,
        requestedLocale: candidate,
        source: "explicit",
        match: match.match,
      };
    }
  }

  return fallbackResolution(config, candidates[0] ?? null, "default");
}

export function detectLocale<TLocale extends string>(
  input: RequestLocaleInput,
  config: ParcaeI18nConfig<TLocale>,
  options: LocaleDetectionOptions = {},
): LocaleResolution<TLocale> {
  assertI18nConfig(config);

  const opts = { ...DEFAULT_DETECTION, ...options };
  const checks: Array<{ source: LocaleSource; candidates: string[] }> = [
    {
      source: "explicit",
      candidates: toLocaleCandidates(input.locale ?? input.language),
    },
    {
      source: "query",
      candidates: toLocaleCandidates(readQuery(input, opts.queryParam)),
    },
    {
      source: "cookie",
      candidates: toLocaleCandidates(readCookie(input, opts.cookieName)),
    },
    {
      source: "header",
      candidates: toLocaleCandidates(readHeader(input.headers, opts.headerName)),
    },
    {
      source: "accept-language",
      candidates: parseAcceptLanguage(
        readHeader(input.headers, opts.acceptLanguageHeader),
      ),
    },
  ];

  for (const check of checks) {
    for (const candidate of check.candidates) {
      const match = matchLocale(candidate, config);
      if (match) {
        return {
          locale: match.locale,
          requestedLocale: candidate,
          source: check.source,
          match: match.match,
        };
      }
    }
  }

  return fallbackResolution(config, null, "default");
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
  const messages = await config.loadMessages(locale);
  i18n.loadAndActivate({
    locale,
    locales: getFormatLocales(config, locale),
    messages,
  });
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

function matchLocale<TLocale extends string>(
  requested: string,
  config: ParcaeI18nConfig<TLocale>,
): { locale: TLocale; match: Exclude<LocaleMatch, "fallback"> } | null {
  const normalized = normalizeLocale(requested);
  const requestedKey = localeKey(normalized);

  for (const locale of config.locales) {
    if (localeKey(locale) === requestedKey) {
      return { locale, match: "exact" };
    }
  }

  const requestedLanguage = requestedKey.split("-")[0];
  for (const locale of config.locales) {
    if (localeKey(locale).split("-")[0] === requestedLanguage) {
      return { locale, match: "language" };
    }
  }

  return null;
}

function fallbackResolution<TLocale extends string>(
  config: ParcaeI18nConfig<TLocale>,
  requestedLocale: string | null,
  source: LocaleSource,
): LocaleResolution<TLocale> {
  return {
    locale: config.fallbackLocale ?? config.defaultLocale,
    requestedLocale,
    source,
    match: "fallback",
  };
}

function toLocaleCandidates(
  input: string | readonly (string | null | undefined)[] | null | undefined,
): string[] {
  const values = Array.isArray(input) ? input : [input];
  return values
    .map((value) => sanitizeLocale(value))
    .filter((value): value is string => Boolean(value));
}

function sanitizeLocale(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().split(/[;,]/)[0]?.trim();
  if (!cleaned || cleaned === "*") return null;
  return normalizeLocale(cleaned);
}

function localeKey(locale: string): string {
  return normalizeLocale(locale).toLowerCase();
}

function readHeader(
  headers: HeaderInput | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null | undefined }).get(
      name,
    ) ?? null;
  }

  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }

  return null;
}

function readQuery(input: RequestLocaleInput, name: string): string | null {
  const direct = input.query?.[name];
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct)) {
    return typeof direct[0] === "string" ? direct[0] : null;
  }

  if (!input.url) return null;
  try {
    return new URL(input.url, "http://parcae.local").searchParams.get(name);
  } catch {
    return null;
  }
}

function readCookie(input: RequestLocaleInput, name: string): string | null {
  const fromBag = readCookieBag(input.cookies, name);
  if (fromBag) return fromBag;
  const header = readHeader(input.headers, "cookie");
  return readCookieBag(header, name);
}

function readCookieBag(
  cookies: CookieInput | undefined | null,
  name: string,
): string | null {
  if (!cookies) return null;

  if (typeof cookies === "string") {
    for (const part of cookies.split(";")) {
      const [rawKey, ...rawValue] = part.trim().split("=");
      if (rawKey !== name) continue;
      return decodeURIComponent(rawValue.join("="));
    }
    return null;
  }

  if (typeof (cookies as { get?: unknown }).get === "function") {
    const value = (cookies as {
      get(name: string): string | { value?: string } | null | undefined;
    }).get(name);
    if (typeof value === "string") return value;
    return value?.value ?? null;
  }

  return (cookies as Record<string, string | undefined>)[name] ?? null;
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as Promise<T>).then === "function",
  );
}

export type { I18n, Messages };
