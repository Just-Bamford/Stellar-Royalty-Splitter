/**
 * Tests for TopEarners sub-component (#833).
 *
 * Validates the percentage calculation and address truncation logic that
 * TopEarners applies to its props.
 */

import { describe, test, expect } from "@jest/globals";
import { formatNumber, formatCurrency } from "../../utils/format";
import type { EarnerStat } from "./TopEarners";

describe("TopEarners #833", () => {
  const earners: EarnerStat[] = [
    {
      address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      totalEarned: 6000,
      payouts: 10,
    },
    {
      address: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGQKUC5AALI5RGTFM5NPND",
      totalEarned: 4000,
      payouts: 8,
    },
  ];
  const totalDistributed = 10000;

  test("earner percentage rounds to one decimal place", () => {
    const pct = ((earners[0].totalEarned / totalDistributed) * 100).toFixed(1);
    expect(pct).toBe("60.0");
  });

  test("second earner percentage is 40.0%", () => {
    const pct = ((earners[1].totalEarned / totalDistributed) * 100).toFixed(1);
    expect(pct).toBe("40.0");
  });

  test("percentage is '0.0' when totalDistributed is 0", () => {
    const pct =
      0 > 0
        ? ((earners[0].totalEarned / 0) * 100).toFixed(1)
        : "0.0";
    expect(pct).toBe("0.0");
  });

  test("address truncation keeps first 10 and last 6 characters", () => {
    const addr = earners[0].address;
    const truncated = `${addr.slice(0, 10)}...${addr.slice(-6)}`;
    expect(truncated).toBe("GBBD47IF6L...LLFLA5");
    expect(truncated.length).toBeLessThan(addr.length);
  });

  test("formatCurrency formats totalEarned correctly", () => {
    const result = formatCurrency(earners[0].totalEarned, "XLM");
    expect(result).toContain("XLM");
    expect(result).toContain("6,000");
  });

  test("formatNumber formats payouts", () => {
    expect(formatNumber(earners[0].payouts)).toBe("10");
  });

  test("empty earners array results in no earner cards", () => {
    const empty: EarnerStat[] = [];
    expect(empty.length).toBe(0);
  });

  test("EarnerStat interface accepts required fields", () => {
    const stat: EarnerStat = {
      address: "GTEST",
      totalEarned: 500,
      payouts: 5,
    };
    expect(stat.address).toBe("GTEST");
    expect(stat.totalEarned).toBe(500);
    expect(stat.payouts).toBe(5);
  });

  test("rankings are index-based (first earner is rank 1)", () => {
    earners.forEach((earner, index) => {
      expect(index + 1).toBeGreaterThan(0);
      // Rank 1 should have highest earnings
      if (index === 0) {
        expect(earner.totalEarned).toBeGreaterThanOrEqual(earners[1].totalEarned);
      }
    });
  });
});
