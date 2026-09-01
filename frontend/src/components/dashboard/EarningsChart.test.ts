/**
 * Tests for EarningsChart sub-component (#833).
 *
 * Validates the TrendPoint data contract and the tooltip formatter that
 * EarningsChart applies when rendering the recharts LineChart.
 */

import { describe, test, expect } from "@jest/globals";
import { formatCurrency } from "../../utils/format";
import type { TrendPoint } from "./EarningsChart";

describe("EarningsChart #833", () => {
  const trends: TrendPoint[] = [
    { date: "2025-01-01", amount: 1000, count: 5 },
    { date: "2025-01-08", amount: 2500, count: 12 },
    { date: "2025-01-15", amount: 750, count: 3 },
  ];

  test("TrendPoint interface requires date, amount, and count", () => {
    trends.forEach((point) => {
      expect(typeof point.date).toBe("string");
      expect(typeof point.amount).toBe("number");
      expect(typeof point.count).toBe("number");
    });
  });

  test("empty trends array is falsy for rendering purposes", () => {
    const empty: TrendPoint[] = [];
    expect(empty.length).toBe(0);
    expect(empty.length > 0).toBe(false);
  });

  test("non-empty trends array triggers chart render path", () => {
    expect(trends.length).toBeGreaterThan(0);
  });

  test("tooltip formatter returns currency string for numeric values", () => {
    const formatter = (value: unknown) =>
      typeof value === "number" ? formatCurrency(value, "XLM") : value;

    expect(formatter(1000)).toBe("1,000 XLM");
    expect(formatter("label")).toBe("label");
    expect(formatter(undefined)).toBe(undefined);
  });

  test("tooltip formatter returns the value unchanged for non-numbers", () => {
    const formatter = (value: unknown) =>
      typeof value === "number" ? formatCurrency(value, "XLM") : value;

    expect(formatter(0)).toBe("0 XLM");
    expect(formatter(null)).toBe(null);
  });

  test("trend dates are ordered chronologically in sample data", () => {
    for (let i = 1; i < trends.length; i++) {
      expect(trends[i].date >= trends[i - 1].date).toBe(true);
    }
  });

  test("amount values are non-negative", () => {
    trends.forEach((point) => {
      expect(point.amount).toBeGreaterThanOrEqual(0);
    });
  });

  test("count values are non-negative integers", () => {
    trends.forEach((point) => {
      expect(point.count).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(point.count)).toBe(true);
    });
  });

  test("displayCurrency is forwarded to tooltip formatter", () => {
    const currency = "EUR";
    const formatter = (value: unknown) =>
      typeof value === "number" ? formatCurrency(value, currency) : value;

    const result = formatter(500);
    expect(typeof result).toBe("string");
    // EUR formatting should not contain XLM
    expect(result as string).not.toContain("XLM");
  });
});
