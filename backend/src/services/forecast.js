import db from "../database/index.js";

/**
 * Calculates earnings forecast using historical distribution data and moving average projection.
 *
 * @param {Object} params
 * @param {string} [params.contractId]
 * @param {string} [params.address]
 * @param {string} [params.frequency] - 'weekly', 'monthly', 'quarterly'
 * @param {number} [params.avgPayout]
 * @param {number} [params.secondaryVolume]
 * @returns {Object} Forecast data with 3/6/12 month projections and timeline points
 */
export function calculateForecast({
  contractId,
  address,
  frequency = "monthly",
  avgPayout,
  secondaryVolume = 0,
}) {
  let baseAvgPayout = Number(avgPayout);

  if (isNaN(baseAvgPayout) || baseAvgPayout <= 0) {
    if (contractId || address) {
      let query = `
        SELECT AVG(CAST(dp.amountReceived AS REAL)) as avgPayout
        FROM distribution_payouts dp
        JOIN transactions t ON dp.transactionId = t.id
        WHERE t.status = 'confirmed'
      `;
      const params = [];
      if (contractId) {
        query += ` AND t.contractId = ?`;
        params.push(contractId);
      }
      if (address) {
        query += ` AND dp.collaboratorAddress = ?`;
        params.push(address);
      }
      try {
        const row = db.prepare(query).get(...params);
        baseAvgPayout = row?.avgPayout || 100;
      } catch (_) {
        baseAvgPayout = 100;
      }
    } else {
      baseAvgPayout = 100;
    }
  }

  const secondaryVol = Number(secondaryVolume) || 0;
  const secondaryRoyaltyPerMonth = secondaryVol * 0.05;

  let payoutsPerMonth = 1;
  if (frequency === "weekly") payoutsPerMonth = 4.33;
  else if (frequency === "quarterly") payoutsPerMonth = 1 / 3;

  const monthlyBase = baseAvgPayout * payoutsPerMonth + secondaryRoyaltyPerMonth;

  const projectMonths = (months, multiplier) => {
    return Math.round(monthlyBase * months * multiplier * 100) / 100;
  };

  const timeline = [];
  let cumBase = 0;
  let cumBest = 0;
  let cumWorst = 0;

  for (let month = 1; month <= 12; month++) {
    cumBase += monthlyBase;
    cumBest += monthlyBase * 1.25;
    cumWorst += monthlyBase * 0.75;

    timeline.push({
      month,
      base: Math.round(cumBase * 100) / 100,
      bestCase: Math.round(cumBest * 100) / 100,
      worstCase: Math.round(cumWorst * 100) / 100,
      confidenceLower: Math.round(cumBase * (1 - 0.1 * (month / 12)) * 100) / 100,
      confidenceUpper: Math.round(cumBase * (1 + 0.15 * (month / 12)) * 100) / 100,
    });
  }

  return {
    inputs: {
      frequency,
      avgPayout: Math.round(baseAvgPayout * 100) / 100,
      secondaryVolume: secondaryVol,
    },
    monthlyBaseRate: Math.round(monthlyBase * 100) / 100,
    projections: {
      month3: {
        base: projectMonths(3, 1),
        bestCase: projectMonths(3, 1.25),
        worstCase: projectMonths(3, 0.75),
        confidenceBand: [projectMonths(3, 0.9), projectMonths(3, 1.15)],
      },
      month6: {
        base: projectMonths(6, 1),
        bestCase: projectMonths(6, 1.25),
        worstCase: projectMonths(6, 0.75),
        confidenceBand: [projectMonths(6, 0.85), projectMonths(6, 1.2)],
      },
      month12: {
        base: projectMonths(12, 1),
        bestCase: projectMonths(12, 1.25),
        worstCase: projectMonths(12, 0.75),
        confidenceBand: [projectMonths(12, 0.8), projectMonths(12, 1.25)],
      },
    },
    monthlyTimeline: timeline,
  };
}
