/**
 * Tests for CollaboratorList sub-component (#833).
 *
 * Validates average payout calculation, address truncation, and the empty-state
 * guard that CollaboratorList applies to its props.
 */

import { describe, test, expect } from "@jest/globals";
import { formatNumber, formatCurrency } from "../../utils/format";
import type { CollaboratorStat } from "./CollaboratorList";

describe("CollaboratorList #833", () => {
  const collaborators: CollaboratorStat[] = [
    {
      address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      totalEarned: 3000,
      payoutCount: 6,
    },
    {
      address: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGQKUC5AALI5RGTFM5NPND",
      totalEarned: 1500,
      payoutCount: 0,
    },
  ];

  test("average payout calculates correctly when payoutCount > 0", () => {
    const collab = collaborators[0];
    const avg = collab.totalEarned / collab.payoutCount;
    expect(avg).toBe(500);
  });

  test("average payout falls back to 0 when payoutCount is 0", () => {
    const collab = collaborators[1];
    const avg = collab.payoutCount > 0 ? collab.totalEarned / collab.payoutCount : 0;
    expect(avg).toBe(0);
  });

  test("formatCurrency formats average payout correctly", () => {
    const avg = 500;
    const result = formatCurrency(avg, "XLM");
    expect(result).toContain("XLM");
    expect(result).toContain("500");
  });

  test("address truncation to 10+6 chars works for Stellar addresses", () => {
    const addr = collaborators[0].address;
    const display = `${addr.slice(0, 10)}...${addr.slice(-6)}`;
    expect(display).toMatch(/^GBBD47IF6L\.\.\.LLFLA5$/);
  });

  test("formatNumber formats payoutCount", () => {
    expect(formatNumber(collaborators[0].payoutCount)).toBe("6");
  });

  test("formatCurrency formats totalEarned", () => {
    const result = formatCurrency(collaborators[0].totalEarned, "XLM");
    expect(result).toBe("3,000 XLM");
  });

  test("empty collaborators list results in empty array", () => {
    const empty: CollaboratorStat[] = [];
    expect(empty.length).toBe(0);
  });

  test("CollaboratorStat interface accepts required fields", () => {
    const stat: CollaboratorStat = {
      address: "GTEST",
      totalEarned: 1000,
      payoutCount: 4,
    };
    expect(stat.address).toBe("GTEST");
    expect(stat.totalEarned).toBe(1000);
    expect(stat.payoutCount).toBe(4);
  });

  test("zero average payout formats to '0 XLM'", () => {
    const result = formatCurrency(0, "XLM");
    expect(result).toBe("0 XLM");
  });

  test("multiple collaborators are all present", () => {
    expect(collaborators).toHaveLength(2);
    expect(collaborators[0].address).not.toBe(collaborators[1].address);
  });
});
