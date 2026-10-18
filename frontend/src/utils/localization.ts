import type { SupportedLanguage } from "../i18n/languages";

export type DisplayCurrency = string;

const LANGUAGE_LOCALES: Record<SupportedLanguage, string> = {
  en: "en-US",
  es: "es-ES",
  zh: "zh-CN",
  ja: "ja-JP",
  fr: "fr-FR",
  de: "de-DE",
  ko: "ko-KR",
  pt: "pt-BR",
  it: "it-IT",
  ru: "ru-RU",
  ar: "ar",
  he: "he-IL",
};

export function getLocale(language: string): string {
  const baseLanguage = language.toLowerCase().split("-")[0] as SupportedLanguage;
  return LANGUAGE_LOCALES[baseLanguage] ?? LANGUAGE_LOCALES.en;
}

export function formatNumber(value: number, language: string, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getLocale(language), options).format(value);
}

export function formatCurrency(value: number, currency: DisplayCurrency, language: string): string {
  const locale = getLocale(language);
  if (currency === "XLM") {
    return `${formatNumber(value, language, { maximumFractionDigits: 7 })} XLM`;
  }
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "JPY" ? 0 : 2,
    }).format(value);
  } catch {
    return `${formatNumber(value, language)} ${currency}`;
  }
}

export function formatDateTime(value: Date | number | string, language: string, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(getLocale(language), options).format(value instanceof Date ? value : new Date(value));
}