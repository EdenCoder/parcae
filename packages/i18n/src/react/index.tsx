import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { I18nProvider } from "@lingui/react";
import { setupI18n } from "@lingui/core";
import type { I18n, Messages } from "@lingui/core";
import {
  activateLocale,
  getFormatLocales,
  resolveLocale,
  type LocaleResolution,
  type ParcaeI18nConfig,
} from "../index";

export interface ParcaeI18nProviderProps<TLocale extends string = string> {
  config: ParcaeI18nConfig<TLocale>;
  /**
   * Initial locale to activate. In routed apps this usually comes from the
   * route segment, cookie, or server-rendered locale.
   */
  initialLocale?: string | null;
  /**
   * Optional messages already loaded on the server. Passing this avoids a
   * client-side catalog fetch on first render.
   */
  initialMessages?: Messages;
  /** Controlled locale. When this changes, the provider activates it. */
  locale?: string | null;
  loadingFallback?: React.ReactNode;
  onLocaleChange?: (resolution: LocaleResolution<TLocale>) => void;
  onError?: (error: Error) => void;
  children: React.ReactNode;
}

export interface ParcaeI18nReactContext<TLocale extends string = string>
  extends LocaleResolution<TLocale> {
  i18n: I18n;
  locales: readonly TLocale[];
  defaultLocale: TLocale;
  loading: boolean;
  error: Error | null;
  setLocale: (locale: string) => Promise<LocaleResolution<TLocale>>;
}

const ParcaeI18nContext =
  createContext<ParcaeI18nReactContext<string> | null>(null);

export function ParcaeI18nProvider<TLocale extends string = string>({
  config,
  initialLocale,
  initialMessages,
  locale: controlledLocale,
  loadingFallback = null,
  onLocaleChange,
  onError,
  children,
}: ParcaeI18nProviderProps<TLocale>) {
  const firstResolution = resolveLocale(
    controlledLocale ?? initialLocale ?? config.defaultLocale,
    config,
  );
  const configRef = useRef(config);
  configRef.current = config;

  const activeLocaleRef = useRef(firstResolution.locale);
  const readyRef = useRef(Boolean(initialMessages));

  const [i18n] = useState(() => {
    const instance = setupI18n({ missing: config.missing });
    if (initialMessages) {
      instance.loadAndActivate({
        locale: firstResolution.locale,
        locales: getFormatLocales(config, firstResolution.locale),
        messages: initialMessages,
      });
    }
    return instance;
  });
  const [resolution, setResolution] =
    useState<LocaleResolution<TLocale>>(firstResolution);
  const [loading, setLoading] = useState(!initialMessages);
  const [error, setError] = useState<Error | null>(null);

  const setLocale = useCallback(
    async (requestedLocale: string): Promise<LocaleResolution<TLocale>> => {
      const currentConfig = configRef.current;
      const nextResolution = resolveLocale(requestedLocale, currentConfig);

      if (readyRef.current && activeLocaleRef.current === nextResolution.locale) {
        setResolution(nextResolution);
        return nextResolution;
      }

      setLoading(true);
      setError(null);

      try {
        await activateLocale(i18n, currentConfig, nextResolution.locale);
        activeLocaleRef.current = nextResolution.locale;
        readyRef.current = true;
        setResolution(nextResolution);
        onLocaleChange?.(nextResolution);
        return nextResolution;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        onError?.(error);
        throw error;
      } finally {
        setLoading(false);
      }
    },
    [i18n, onError, onLocaleChange],
  );

  const requestedLocale =
    controlledLocale ?? initialLocale ?? config.defaultLocale;

  useEffect(() => {
    let cancelled = false;
    setLocale(requestedLocale).catch((err) => {
      if (cancelled) return;
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
    });
    return () => {
      cancelled = true;
    };
  }, [requestedLocale, setLocale]);

  const value = useMemo<ParcaeI18nReactContext<TLocale>>(
    () => ({
      ...resolution,
      i18n,
      locales: config.locales,
      defaultLocale: config.defaultLocale,
      loading,
      error,
      setLocale,
    }),
    [
      config.defaultLocale,
      config.locales,
      error,
      i18n,
      loading,
      resolution,
      setLocale,
    ],
  );

  if (!readyRef.current && loading && loadingFallback !== null) {
    return <>{loadingFallback}</>;
  }

  return (
    <ParcaeI18nContext.Provider
      value={value as ParcaeI18nReactContext<string>}
    >
      <I18nProvider i18n={i18n}>{children}</I18nProvider>
    </ParcaeI18nContext.Provider>
  );
}

export function useParcaeI18n<
  TLocale extends string = string,
>(): ParcaeI18nReactContext<TLocale> {
  const context = useContext(ParcaeI18nContext);
  if (!context) {
    throw new Error(
      "useParcaeI18n must be used within a <ParcaeI18nProvider>",
    );
  }
  return context as ParcaeI18nReactContext<TLocale>;
}

export function useLocale<TLocale extends string = string>(): [
  TLocale,
  (locale: string) => Promise<LocaleResolution<TLocale>>,
] {
  const { locale, setLocale } = useParcaeI18n<TLocale>();
  return [locale, setLocale];
}

export { I18nProvider, Trans, useLingui } from "@lingui/react";
export type { I18n, Messages };
