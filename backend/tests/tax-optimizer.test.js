/**
 * Tests for the tax optimization engine (#1040).
 */

import { describe, test, expect } from "@jest/globals";
import {
  DAY_MS,
  DEFAULT_TAX_RATES,
  classifyDisposal,
  computeGain,
  detectWashSales,
  estimateTaxLiability,
  holdingPeriodDays,
  isLongTerm,
  recommendWithdrawalTiming,
} from "../src/services/tax-optimizer.js";

const ACQUIRED = Date.UTC(2024, 0, 1);

function daysAfter(base, days) {
  return base + days * DAY_MS;
}

describe("tax optimizer (#1040)", () => {
  test("classifies the long-term boundary at exactly 366 days", () => {
    expect(holdingPeriodDays(ACQUIRED, daysAfter(ACQUIRED, 365))).toBe(365);
    expect(isLongTerm(ACQUIRED, daysAfter(ACQUIRED, 365))).toBe(false);
    expect(isLongTerm(ACQUIRED, daysAfter(ACQUIRED, 366))).toBe(true);
  });

  test("computes gains and classifies disposals", () => {
    expect(computeGain({ proceeds: 150, costBasis: 100 })).toBe(50);
    expect(computeGain({ proceeds: 80, costBasis: 100 })).toBe(-20);

    const shortTerm = classifyDisposal({
      proceeds: 150,
      costBasis: 100,
      acquiredAt: ACQUIRED,
      disposedAt: daysAfter(ACQUIRED, 100),
    });
    expect(shortTerm).toEqual({ gain: 50, term: "short", holdingDays: 100 });

    const longTerm = classifyDisposal({
      proceeds: 150,
      costBasis: 100,
      acquiredAt: ACQUIRED,
      disposedAt: daysAfter(ACQUIRED, 400),
    });
    expect(longTerm.term).toBe("long");
  });

  test("estimates liability across short- and long-term gains", () => {
    const result = estimateTaxLiability([
      { proceeds: 200, costBasis: 100, acquiredAt: ACQUIRED, disposedAt: daysAfter(ACQUIRED, 30) },
      { proceeds: 300, costBasis: 100, acquiredAt: ACQUIRED, disposedAt: daysAfter(ACQUIRED, 400) },
    ]);

    expect(result.shortTermGains).toBe(100);
    expect(result.longTermGains).toBe(200);
    expect(result.shortTermTax).toBeCloseTo(100 * DEFAULT_TAX_RATES.shortTerm);
    expect(result.longTermTax).toBeCloseTo(200 * DEFAULT_TAX_RATES.longTerm);
    expect(result.totalTax).toBeCloseTo(result.shortTermTax + result.longTermTax);
  });

  test("adds disallowed wash-sale losses back into taxable gains", () => {
    const sale = {
      asset: "XLM",
      proceeds: 50,
      costBasis: 150,
      acquiredAt: ACQUIRED,
      disposedAt: daysAfter(ACQUIRED, 30),
    };
    const washSales = detectWashSales({
      sales: [sale],
      purchases: [{ asset: "XLM", purchasedAt: daysAfter(ACQUIRED, 35) }],
    });
    expect(washSales).toHaveLength(1);
    expect(washSales[0].disallowedLoss).toBe(100);

    const result = estimateTaxLiability([sale], { washSales });
    // The -100 loss is disallowed, so short-term gains return to 0.
    expect(result.disallowedLosses).toBe(100);
    expect(result.shortTermGains).toBe(0);
    expect(result.totalTax).toBe(0);
  });

  test("detects wash sales only inside the 30-day window and only for losses", () => {
    const lossSale = {
      asset: "XLM",
      proceeds: 50,
      costBasis: 150,
      disposedAt: daysAfter(ACQUIRED, 100),
    };
    const gainSale = {
      asset: "XLM",
      proceeds: 150,
      costBasis: 50,
      disposedAt: daysAfter(ACQUIRED, 100),
    };

    expect(
      detectWashSales({
        sales: [lossSale],
        purchases: [{ asset: "XLM", purchasedAt: daysAfter(ACQUIRED, 130) }],
      })
    ).toHaveLength(1);

    expect(
      detectWashSales({
        sales: [lossSale],
        purchases: [{ asset: "XLM", purchasedAt: daysAfter(ACQUIRED, 131) }],
      })
    ).toHaveLength(0);

    expect(
      detectWashSales({
        sales: [gainSale],
        purchases: [{ asset: "XLM", purchasedAt: daysAfter(ACQUIRED, 105) }],
      })
    ).toHaveLength(0);

    expect(
      detectWashSales({
        sales: [lossSale],
        purchases: [{ asset: "USDC", purchasedAt: daysAfter(ACQUIRED, 105) }],
      })
    ).toHaveLength(0);
  });

  test("recommends waiting for long-term treatment", () => {
    const asOf = daysAfter(ACQUIRED, 30);
    const [rec] = recommendWithdrawalTiming(
      [{ asset: "XLM", acquiredAt: ACQUIRED, currentValue: 200, costBasis: 100 }],
      { asOf }
    );

    expect(rec.action).toBe("wait-for-long-term");
    expect(rec.estimatedTaxNow).toBeCloseTo(100 * DEFAULT_TAX_RATES.shortTerm);
    expect(rec.estimatedTaxLater).toBeCloseTo(100 * DEFAULT_TAX_RATES.longTerm);
    expect(rec.savings).toBeCloseTo(
      100 * (DEFAULT_TAX_RATES.shortTerm - DEFAULT_TAX_RATES.longTerm)
    );
  });

  test("recommends harvesting a loss unless a wash sale blocks it", () => {
    const asOf = daysAfter(ACQUIRED, 30);
    const holding = { asset: "XLM", acquiredAt: ACQUIRED, currentValue: 60, costBasis: 100 };

    const [harvest] = recommendWithdrawalTiming([holding], { asOf });
    expect(harvest.action).toBe("harvest-loss");

    const [blocked] = recommendWithdrawalTiming([holding], {
      asOf,
      purchases: [{ asset: "XLM", purchasedAt: asOf }],
    });
    expect(blocked.action).toBe("hold");
    expect(blocked.savings).toBe(0);
  });

  test("defers a long-term gain into the next tax year near year end", () => {
    const asOf = Date.UTC(2026, 11, 20); // Dec 20
    const acquired = Date.UTC(2024, 0, 1);
    const [rec] = recommendWithdrawalTiming(
      [{ asset: "XLM", acquiredAt: acquired, currentValue: 200, costBasis: 100 }],
      { asOf }
    );

    expect(rec.action).toBe("defer-to-next-year");
    expect(new Date(rec.suggestedDate).getUTCFullYear()).toBe(2027);
  });

  test("sorts recommendations by savings descending", () => {
    const asOf = daysAfter(ACQUIRED, 30);
    const recs = recommendWithdrawalTiming(
      [
        { asset: "SMALL", acquiredAt: ACQUIRED, currentValue: 110, costBasis: 100 },
        { asset: "BIG", acquiredAt: ACQUIRED, currentValue: 1000, costBasis: 100 },
      ],
      { asOf }
    );

    expect(recs[0].asset).toBe("BIG");
    expect(recs[0].savings).toBeGreaterThanOrEqual(recs[1].savings);
  });
});
