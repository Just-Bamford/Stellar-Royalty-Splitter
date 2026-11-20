import { formatCurrency as formatLocalizedCurrency, formatDateTime as formatLocalizedDateTime, getLocale } from "./localization";

function currentLanguage(): string {
  return typeof document === "undefined" ? "en" : document.documentElement.lang || "en";
}

/**
 * Formats a Date as a local-timezone YYYY-MM-DD string.
 * Uses local getters (getFullYear, getMonth, getDate) so the result matches
 * the user's local calendar date, unlike toISOString() which returns UTC.
 */
export const localDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/**
 * Formats a number with thousand separators and abbreviates large values.
 * Example: 1234567 -> 1.23M
 * Example: 1234 -> 1,234
 */
export const formatNumber = (num: number | string | bigint): string => {
  const value = typeof num === 'string' ? parseFloat(num) : Number(num);
  const locale = getLocale(currentLanguage());
  
  if (isNaN(value)) return '0';

  // Abbreviate only large numbers (Millions and Billions)
  if (value >= 1_000_000_000) {
    return (value / 1_000_000_000).toFixed(2).replace(/\.00$/, '') + 'B';
  }
  if (value >= 1_000_000) {
    return (value / 1_000_000).toFixed(2).replace(/\.00$/, '') + 'M';
  }

  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2
  }).format(value);
};

/**
 * Formats currency amounts using the formatNumber utility.
 */
export const formatCurrency = (value: number, currency: string): string => {
  return formatLocalizedCurrency(value, currency, currentLanguage());
};

export const formatDateTime = (value: Date | number | string, options?: Intl.DateTimeFormatOptions): string =>
  formatLocalizedDateTime(value, currentLanguage(), options);