/**
 * Tests for MetricsGrid sub-component (#833).
 *
 * These tests validate the prop-based data contracts and the format utilities
 * that MetricsGrid delegates to, without requiring a DOM renderer.
 */

import { describe, test, expect } from "@jest/globals";
import { formatNumber, formatCurrency } from "../../utils/format";
import type { MetricsData } from "./MetricsGrid";

describe("MetricsGrid #833", () => {
  const sample: MetricsData = {
    totalDistributed: 12345.67,
    totalTransactions: 42,
    averagePayout: 293.94,
    collaboratorCount: 3,
  };

  test("formatNumber formats totalTransactions correctly", () => {
    expect(formatNumber(sample.totalTransactions)).toBe("42");
  });

  test("formatNumber formats large collaboratorCount with abbreviation", () => {
    expect(formatNumber(1_500_000)).toBe("1.50M");
  });

  test("formatCurrency formats totalDistributed with XLM suffix", () => {
    const result = formatCurrency(sample.totalDistributed, "XLM");
    expect(result).toContain("XLM");
    expect(result).toContain("12,345.67");
  });

  test("formatCurrency formats averagePayout with XLM suffix", () => {
    const result = formatCurrency(sample.averagePayout, "XLM");
    expect(result).toContain("XLM");
  });

  test("collaboratorCount of zero formats as '0'", () => {
    const metrics: MetricsData = { ...sample, collaboratorCount: 0 };
    expect(formatNumber(metrics.collaboratorCount)).toBe("0");
  });

  test("totalDistributed of zero renders as '0 XLM'", () => {
    const metrics: MetricsData = { ...sample, totalDistributed: 0 };
    expect(formatCurrency(metrics.totalDistributed, "XLM")).toBe("0 XLM");
  });

  test("MetricsData interface accepts all four required fields", () => {
    const m: MetricsData = {
      totalDistributed: 100,
      totalTransactions: 5,
      averagePayout: 20,
      collaboratorCount: 2,
    };
    expect(m).toBeDefined();
    expect(Object.keys(m)).toHaveLength(4);
  });

  test("formatNumber handles string input", () => {
    expect(formatNumber("1234")).toBe("1,234");
  });

  test("formatNumber handles NaN gracefully", () => {
    expect(formatNumber("not-a-number")).toBe("0");
  });
});
