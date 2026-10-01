/**
 * DeFi strategy recommendations (#1040).
 *
 * Ranks yield opportunities for a collaborator's risk tolerance and horizon.
 * The catalogue is a static, deterministic snapshot so recommendations are
 * reproducible and testable; live APYs would be injected by a price/oracle
 * service in production (see `price-oracle.js`).
 *
 * Risk levels: 1 = principal-protected, 5 = experimental. A tolerance maps to
 * the highest risk level the collaborator accepts.
 */

/** Highest risk level accepted by each tolerance. */
export const RISK_TOLERANCE_LEVELS = Object.freeze({
  conservative: 2,
  balanced: 4,
  aggressive: 5,
});

/**
 * Yield opportunities. `lockupDays` is the minimum holding period before the
 * principal can be withdrawn without penalty.
 */
export const STRATEGY_CATALOG = Object.freeze([
  Object.freeze({
    id: "xlm-native-staking",
    name: "XLM Native Staking",
    type: "staking",
    apy: 0.05,
    riskLevel: 1,
    lockupDays: 0,
  }),
  Object.freeze({
    id: "blend-usdc-lending",
    name: "Blend USDC Lending",
    type: "lending",
    apy: 0.08,
    riskLevel: 2,
    lockupDays: 0,
  }),
  Object.freeze({
    id: "stellar-amm-xlm-usdc",
    name: "Stellar AMM LP (XLM/USDC)",
    type: "liquidity",
    apy: 0.15,
    riskLevel: 3,
    lockupDays: 0,
  }),
  Object.freeze({
    id: "concentrated-lp",
    name: "Concentrated Liquidity LP",
    type: "liquidity",
    apy: 0.25,
    riskLevel: 4,
    lockupDays: 7,
  }),
  Object.freeze({
    id: "boosted-yield-vault",
    name: "Boosted Yield Vault",
    type: "vault",
    apy: 0.35,
    riskLevel: 5,
    lockupDays: 30,
  }),
]);

function assertPositive(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
}

/**
 * Project returns for an amount held for a horizon.
 *
 * @param {{ apy: number }} strategy
 * @param {{ amountUsd: number, horizonDays: number, compound?: boolean }} params
 * @returns {{ apy: number, simpleReturn: number, compoundedReturn: number, horizonDays: number }}
 */
export function projectReturns(strategy, { amountUsd, horizonDays, compound = true }) {
  assertPositive("amountUsd", amountUsd);
  assertPositive("horizonDays", horizonDays);
  if (!Number.isFinite(strategy?.apy)) throw new TypeError("strategy.apy must be finite");

  const simpleReturn = amountUsd * strategy.apy * (horizonDays / 365);
  const dailyRate = strategy.apy / 365;
  const compoundedReturn = compound
    ? amountUsd * (Math.pow(1 + dailyRate, horizonDays) - 1)
    : simpleReturn;

  return { apy: strategy.apy, simpleReturn, compoundedReturn, horizonDays };
}

/**
 * Recommend strategies for a risk tolerance and horizon.
 *
 * @param {object} params
 * @param {"conservative"|"balanced"|"aggressive"} [params.riskTolerance]
 * @param {number} [params.horizonDays]
 * @param {number} [params.amountUsd]
 * @param {string[]} [params.excludeIds]
 * @returns {Array<object>} strategies with projected returns, best first
 */
export function recommendStrategies({
  riskTolerance = "balanced",
  horizonDays = 365,
  amountUsd = 1000,
  excludeIds = [],
} = {}) {
  const maxRisk = RISK_TOLERANCE_LEVELS[riskTolerance];
  if (maxRisk === undefined) {
    throw new TypeError(
      `unknown riskTolerance "${riskTolerance}"; expected one of ${Object.keys(
        RISK_TOLERANCE_LEVELS
      ).join(", ")}`
    );
  }
  assertPositive("horizonDays", horizonDays);
  assertPositive("amountUsd", amountUsd);

  const excluded = new Set(excludeIds);

  return STRATEGY_CATALOG.filter(
    (strategy) =>
      strategy.riskLevel <= maxRisk &&
      strategy.lockupDays <= horizonDays &&
      !excluded.has(strategy.id)
  )
    .map((strategy) => {
      const projection = projectReturns(strategy, { amountUsd, horizonDays });
      return {
        ...strategy,
        projectedReturn: projection.compoundedReturn,
        projectedSimpleReturn: projection.simpleReturn,
        reason: `Risk ${strategy.riskLevel}/5 within "${riskTolerance}" tolerance; ${
          strategy.lockupDays === 0
            ? "no lockup"
            : `${strategy.lockupDays}-day lockup fits the ${horizonDays}-day horizon`
        }`,
      };
    })
    .sort((a, b) => b.projectedReturn - a.projectedReturn);
}

/**
 * Split an amount across the top recommendations and report blended APY.
 *
 * @param {Array<{ id: string, apy: number }>} recommendations
 * @param {{ amountUsd: number, allocations?: number[] }} params
 * @returns {{ allocations: Array<{ id: string, amountUsd: number, apy: number }>,
 *            blendedApy: number, projectedReturn: number }}
 */
export function allocatePortfolio(recommendations, { amountUsd, allocations } = {}) {
  assertPositive("amountUsd", amountUsd);
  if (recommendations.length === 0) {
    return { allocations: [], blendedApy: 0, projectedReturn: 0 };
  }

  const weights =
    allocations && allocations.length === recommendations.length
      ? allocations
      : recommendations.map(() => 1 / recommendations.length);

  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  if (weightSum <= 0) throw new TypeError("allocation weights must sum to a positive value");

  let blendedApy = 0;
  let projectedReturn = 0;
  const result = recommendations.map((strategy, index) => {
    const share = (weights[index] ?? 0) / weightSum;
    const slice = amountUsd * share;
    blendedApy += strategy.apy * share;
    projectedReturn += slice * strategy.apy;
    return { id: strategy.id, amountUsd: slice, apy: strategy.apy };
  });

  return { allocations: result, blendedApy, projectedReturn };
}
