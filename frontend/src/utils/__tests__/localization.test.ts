import { describe, expect, it } from "vitest";
import { formatCurrency, formatDateTime, formatNumber, getLocale } from "../localization";
import { RTL_LANGUAGES, SUPPORTED_LANGUAGES } from "../../i18n/languages";

describe("localization", () => {
  it("registers the requested languages and RTL locales", () => {
    expect(SUPPORTED_LANGUAGES.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["es", "zh", "ja", "fr", "de", "ko", "pt", "it", "ru", "ar", "he"]),
    );
    expect(RTL_LANGUAGES.has("ar")).toBe(true);
    expect(RTL_LANGUAGES.has("he")).toBe(true);
  });

  it("resolves regional language tags to a locale", () => {
    expect(getLocale("de-AT")).toBe("de-DE");
    expect(getLocale("unknown")).toBe("en-US");
  });

  it("formats numbers and currencies according to the selected locale", () => {
    expect(formatNumber(1234.5, "de")).toBe("1.234,5");
    expect(formatNumber(1234.5, "en")).toBe("1,234.5");
    expect(formatCurrency(1234, "JPY", "ja")).toContain("1,234");
    expect(formatCurrency(1234.5, "EUR", "de")).toContain("1.234,50");
  });

  it("formats the same date using the selected language", () => {
    const date = new Date("2025-03-04T12:30:00.000Z");
    expect(formatDateTime(date, "en", { dateStyle: "short" })).not.toBe(
      formatDateTime(date, "ja", { dateStyle: "short" }),
    );
  });
});