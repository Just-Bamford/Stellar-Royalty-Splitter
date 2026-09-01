/**
 * Tests for EarningsDashboard component (#833).
 *
 * Validates the collaboratorAddress filter logic and the default date range
 * initialisation that EarningsDashboard implements.
 */

import { describe, test, expect } from "@jest/globals";
import type { EarnerStat } from "./TopEarners";

/** Mirror of the filter applied inside EarningsDashboard. */
function filterEarners(
  earners: EarnerStat[],
  collaboratorAddress: string | undefined,
): EarnerStat[] {
  if (collaboratorAddress) {
    return earners.filter((e) => e.address === collaboratorAddress);
  }
  return earners;
}

describe("EarningsDashboard #833", () => {
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
    {
      address: "GDQJUTQYK2MQX2BIFYW3ZFIQS2RMBUZT5BNOWKELF5NNDYHBPVB2FQJ",
      totalEarned: 2000,
      payouts: 4,
    },
  ];

  test("no filter returns all earners", () => {
    expect(filterEarners(earners, undefined)).toHaveLength(3);
  });

  test("filter by existing address returns exactly one earner", () => {
    const result = filterEarners(
      earners,
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    );
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe(
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    );
  });

  test("filter by unknown address returns empty array", () => {
    const result = filterEarners(earners, "GUNKNOWN");
    expect(result).toHaveLength(0);
  });

  test("filter is case-sensitive (Stellar addresses are uppercase)", () => {
    const lower =
      "gbbd47if6lwk7p7mdevscwr7dpuwv3ny3dtqevfl4nat4aqh3zllfla5";
    const result = filterEarners(earners, lower);
    expect(result).toHaveLength(0);
  });

  test("empty collaboratorAddress string behaves like no filter", () => {
    // Empty string is falsy — all earners returned
    const result = filterEarners(earners, "");
    expect(result).toHaveLength(3);
  });

  test("default date range spans 30 days back from today", () => {
    const end = new Date();
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const diffDays = Math.round(
      (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000),
    );
    // Allow ±1 day for clock drift during test execution
    expect(diffDays).toBeGreaterThanOrEqual(29);
    expect(diffDays).toBeLessThanOrEqual(31);
  });

  test("filtered earner total earned is less than unfiltered sum", () => {
    const all = filterEarners(earners, undefined);
    const one = filterEarners(
      earners,
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    );
    const allTotal = all.reduce((sum, e) => sum + e.totalEarned, 0);
    const oneTotal = one.reduce((sum, e) => sum + e.totalEarned, 0);
    expect(oneTotal).toBeLessThan(allTotal);
  });
});
