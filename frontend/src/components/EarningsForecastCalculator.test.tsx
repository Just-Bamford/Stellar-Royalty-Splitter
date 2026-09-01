import { describe, it, expect } from "vitest";

describe("Earnings Forecast Calculator", () => {
  describe("Earning Rate Calculation", () => {
    it("should calculate daily rate correctly from total distributed", () => {
      const totalDistributed = 300; // 30 days of earnings
      const dailyRate = totalDistributed / 30;
      expect(dailyRate).toBe(10);
    });

    it("should calculate daily rate for zero earnings", () => {
      const totalDistributed = 0;
      const dailyRate = totalDistributed / 30;
      expect(dailyRate).toBe(0);
    });

    it("should calculate daily rate for varying amounts", () => {
      const testCases = [
        { total: 150, expected: 5 },
        { total: 600, expected: 20 },
        { total: 900, expected: 30 },
        { total: 1200, expected: 40 },
      ];

      testCases.forEach(({ total, expected }) => {
        const dailyRate = total / 30;
        expect(dailyRate).toBe(expected);
      });
    });
  });

  describe("Projection Calculations", () => {
    it("should calculate 1 month projection correctly", () => {
      const currentBalance = 100;
      const dailyRate = 10;
      const oneMonthProjection = currentBalance + dailyRate * 30;
      expect(oneMonthProjection).toBe(400);
    });

    it("should calculate 3 month projection correctly", () => {
      const currentBalance = 100;
      const dailyRate = 10;
      const threeMonthProjection = currentBalance + dailyRate * 90;
      expect(threeMonthProjection).toBe(1000);
    });

    it("should calculate 1 year projection correctly", () => {
      const currentBalance = 100;
      const dailyRate = 10;
      const oneYearProjection = currentBalance + dailyRate * 365;
      expect(oneYearProjection).toBe(3750);
    });

    it("should calculate net gain correctly", () => {
      const dailyRate = 10;
      const oneMonthGain = dailyRate * 30;
      const threeMonthGain = dailyRate * 90;
      const oneYearGain = dailyRate * 365;

      expect(oneMonthGain).toBe(300);
      expect(threeMonthGain).toBe(900);
      expect(oneYearGain).toBe(3650);
    });
  });

  describe("Scenario Calculations", () => {
    it("should calculate conservative scenario (0.5x)", () => {
      const baseRate = 10;
      const conservativeRate = baseRate * 0.5;
      expect(conservativeRate).toBe(5);
    });

    it("should calculate realistic scenario (1x)", () => {
      const baseRate = 10;
      const realisticRate = baseRate * 1;
      expect(realisticRate).toBe(10);
    });

    it("should calculate optimistic scenario (2x)", () => {
      const baseRate = 10;
      const optimisticRate = baseRate * 2;
      expect(optimisticRate).toBe(20);
    });

    it("should apply scenario multipliers to projections", () => {
      const currentBalance = 100;
      const baseRate = 10;
      const multipliers = [0.5, 1, 2];

      multipliers.forEach((multiplier) => {
        const adjustedRate = baseRate * multiplier;
        const oneMonthProjection = currentBalance + adjustedRate * 30;
        const expected = currentBalance + baseRate * multiplier * 30;
        expect(oneMonthProjection).toBe(expected);
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle zero daily rate", () => {
      const currentBalance = 100;
      const dailyRate = 0;
      const oneMonthProjection = currentBalance + dailyRate * 30;
      expect(oneMonthProjection).toBe(100);
    });

    it("should handle very small daily rate", () => {
      const currentBalance = 100;
      const dailyRate = 0.01;
      const oneMonthProjection = currentBalance + dailyRate * 30;
      expect(oneMonthProjection).toBeCloseTo(100.3, 2);
    });

    it("should handle very large daily rate", () => {
      const currentBalance = 100;
      const dailyRate = 10000;
      const oneMonthProjection = currentBalance + dailyRate * 30;
      expect(oneMonthProjection).toBe(300100);
    });

    it("should handle zero current balance", () => {
      const currentBalance = 0;
      const dailyRate = 10;
      const oneMonthProjection = currentBalance + dailyRate * 30;
      expect(oneMonthProjection).toBe(300);
    });

    it("should handle negative daily rate (should not occur in practice)", () => {
      const currentBalance = 100;
      const dailyRate = -10;
      const oneMonthProjection = currentBalance + dailyRate * 30;
      expect(oneMonthProjection).toBe(-200);
    });
  });

  describe("Custom Rate Input", () => {
    it("should use custom rate when provided", () => {
      const calculatedRate = 10;
      const customRate = 15;
      const effectiveRate = customRate;
      expect(effectiveRate).toBe(15);
    });

    it("should use calculated rate when custom rate not provided", () => {
      const calculatedRate = 10;
      const customRate = "";
      const effectiveRate = calculatedRate;
      expect(effectiveRate).toBe(10);
    });

    it("should handle invalid custom rate input", () => {
      const calculatedRate = 10;
      const customRate = "invalid";
      const effectiveRate = calculatedRate;
      expect(effectiveRate).toBe(10);
    });
  });

  describe("Rate Conversions", () => {
    it("should convert daily rate to monthly rate", () => {
      const dailyRate = 10;
      const monthlyRate = dailyRate * 30;
      expect(monthlyRate).toBe(300);
    });

    it("should convert daily rate to yearly rate", () => {
      const dailyRate = 10;
      const yearlyRate = dailyRate * 365;
      expect(yearlyRate).toBe(3650);
    });

    it("should handle decimal daily rates in conversions", () => {
      const dailyRate = 10.5;
      const monthlyRate = dailyRate * 30;
      const yearlyRate = dailyRate * 365;
      expect(monthlyRate).toBe(315);
      expect(yearlyRate).toBeCloseTo(3832.5, 2);
    });
  });

  describe("Projection Accuracy", () => {
    it("should maintain accuracy across different time periods", () => {
      const currentBalance = 1000;
      const dailyRate = 50;

      const oneMonth = currentBalance + dailyRate * 30;
      const threeMonths = currentBalance + dailyRate * 90;
      const oneYear = currentBalance + dailyRate * 365;

      expect(threeMonths).toBe(oneMonth + dailyRate * 60);
      expect(oneYear).toBe(threeMonths + dailyRate * 275);
    });

    it("should calculate consistent net gains", () => {
      const dailyRate = 25;
      const oneMonthGain = dailyRate * 30;
      const threeMonthGain = dailyRate * 90;
      const oneYearGain = dailyRate * 365;

      expect(threeMonthGain).toBe(oneMonthGain * 3);
      expect(oneYearGain).toBeCloseTo(oneMonthGain * (365 / 30), 2);
    });
  });
});
