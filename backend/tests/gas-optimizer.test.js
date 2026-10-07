import { describe, expect, test } from "@jest/globals";
import {
  calculateSavingsPercentage,
  determineOptimalBatchSize,
  estimateBatchClaimCosts,
} from "../src/services/gas-optimizer.js";

const model = { transactionBaseFee: 100n, perDistributionFee: 25n, maxBatchSize: 4, source: "test" };

describe("gas optimizer", () => {
  test("handles an empty batch", () => {
    expect(estimateBatchClaimCosts(0, model)).toMatchObject({ individualCost: "0", batchCost: "0", savings: "0", savingsPercent: 0, batchingRecommended: false });
  });

  test("handles one, two, and multiple claims", () => {
    expect(estimateBatchClaimCosts(1, model)).toMatchObject({ individualCost: "125", batchCost: "125", savings: "0" });
    expect(estimateBatchClaimCosts(2, model)).toMatchObject({ individualCost: "250", batchCost: "150", savings: "100", savingsPercent: 40 });
    expect(estimateBatchClaimCosts(4, model)).toMatchObject({ individualCost: "500", batchCost: "200", savings: "300", savingsPercent: 60 });
  });

  test("caps batch size by contract and resource limits", () => {
    expect(determineOptimalBatchSize(20, model)).toBe(4);
    expect(determineOptimalBatchSize(3, model, 2)).toBe(2);
    expect(determineOptimalBatchSize(0, model)).toBe(0);
  });

  test("rejects invalid and oversized batches", () => {
    expect(() => estimateBatchClaimCosts(-1, model)).toThrow(RangeError);
    expect(() => estimateBatchClaimCosts(5, model)).toThrow(/supported batch size/);
    expect(() => determineOptimalBatchSize(1, model, 0)).toThrow(RangeError);
  });

  test("never reports negative savings and rounds percentage down", () => {
    const expensiveBatch = { transactionBaseFee: 0n, perDistributionFee: 10n, maxBatchSize: 4 };
    expect(estimateBatchClaimCosts(2, expensiveBatch).savings).toBe("0");
    expect(calculateSavingsPercentage(1n, 3n)).toBe(33.33);
  });
});
