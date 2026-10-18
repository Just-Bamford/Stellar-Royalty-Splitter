/**
 * Fee estimates for the existing `batch_distribute(Vec<Address>)` contract
 * invocation. Amounts are integer stroops. The caller should provide fees
 * obtained from Soroban simulation whenever available; the default model is
 * deliberately labelled as an assumption, not a network quote.
 */
export const DEFAULT_FEE_MODEL = Object.freeze({
  transactionBaseFee: 100n,
  perDistributionFee: 0n,
  maxBatchSize: 50,
  source: "Soroban base-fee fallback only; resource fees require simulation and are not included",
});

function toNonNegativeBigInt(value, name) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function normalizeModel(model = {}) {
  const maxBatchSize = Number(model.maxBatchSize ?? DEFAULT_FEE_MODEL.maxBatchSize);
  if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new RangeError("maxBatchSize must be a positive safe integer");
  }

  return {
    transactionBaseFee: toNonNegativeBigInt(
      model.transactionBaseFee ?? DEFAULT_FEE_MODEL.transactionBaseFee,
      "transactionBaseFee",
    ),
    perDistributionFee: toNonNegativeBigInt(
      model.perDistributionFee ?? DEFAULT_FEE_MODEL.perDistributionFee,
      "perDistributionFee",
    ),
    maxBatchSize,
    source: model.source ?? DEFAULT_FEE_MODEL.source,
  };
}

export function calculateSavingsPercentage(savings, individualCost) {
  if (individualCost <= 0n || savings <= 0n) return 0;
  return Number((savings * 10_000n) / individualCost) / 100;
}

/**
 * Estimate individual and one-transaction batch costs. Fees stay BigInt
 * internally so stroop values never lose precision in JavaScript Numbers.
 */
export function estimateBatchClaimCosts(claimCount, model) {
  if (!Number.isSafeInteger(claimCount) || claimCount < 0) {
    throw new RangeError("claimCount must be a non-negative safe integer");
  }
  const feeModel = normalizeModel(model);
  if (claimCount > feeModel.maxBatchSize) {
    throw new RangeError(`claimCount exceeds the supported batch size of ${feeModel.maxBatchSize}`);
  }

  const count = BigInt(claimCount);
  const individualCost = count * (feeModel.transactionBaseFee + feeModel.perDistributionFee);
  const batchCost = claimCount === 0 ? 0n : feeModel.transactionBaseFee + count * feeModel.perDistributionFee;
  const savings = individualCost > batchCost ? individualCost - batchCost : 0n;

  return {
    claimCount,
    individualCost: individualCost.toString(),
    batchCost: batchCost.toString(),
    savings: savings.toString(),
    savingsPercent: calculateSavingsPercentage(savings, individualCost),
    batchingRecommended: claimCount > 1 && savings > 0n,
    source: feeModel.source,
  };
}

/**
 * Select the largest valid batch that fits both the requested work and the
 * contract/resource cap. A caller can pass a lower resource cap from a
 * simulation response.
 */
export function determineOptimalBatchSize(claimCount, model = {}, resourceMaxBatchSize) {
  if (!Number.isSafeInteger(claimCount) || claimCount < 0) {
    throw new RangeError("claimCount must be a non-negative safe integer");
  }
  const feeModel = normalizeModel(model);
  const resourceLimit = resourceMaxBatchSize ?? feeModel.maxBatchSize;
  if (!Number.isSafeInteger(resourceLimit) || resourceLimit < 1) {
    throw new RangeError("resourceMaxBatchSize must be a positive safe integer");
  }
  return Math.min(claimCount, feeModel.maxBatchSize, resourceLimit);
}
