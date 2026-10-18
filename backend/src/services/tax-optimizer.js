/**
 * Tax optimization engine (#1040).
 *
 * Turns a collaborator's disposal history and open positions into actionable,
 * deterministic guidance:
 *
 *   - capital-gain/short-vs-long-term classification;
 *   - estimated tax liability under configurable rates;
 *   - IRS-style wash-sale detection over losses (30-day window before/after);
 *   - withdrawal-timing recommendations that avoid wash sales, reach long-term
 *     treatment, or shift a gain into the next tax year.
 *
 * All monetary values are numbers in a single unit (e.g. US cents or USD); the
 * module never mixes assets by itself. Timestamps accept `Date`, ms epoch, or
 * ISO strings and are normalised to ms epoch.
 *
 * Assumptions are documented inline: the default rates approximate a top US
 * bracket and are overridable per call. This is guidance, not filing software.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A position must be held MORE than one year (366+ days) to be long-term. */
export const LONG_TERM_HOLDING_DAYS = 365;

/** IRS wash-sale window: 30 days before or after the loss sale. */
export const WASH_SALE_WINDOW_DAYS = 30;

/** Days before year end after which deferring a gain into January is advised. */
export const YEAR_END_DEFERRAL_DAYS = 45;

/** Default rates (approximate top US bracket). Override per call. */
export const DEFAULT_TAX_RATES = Object.freeze({
  shortTerm: 0.37,
  longTerm: 0.2,
});

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new TypeError(`invalid timestamp: ${value}`);
  return parsed;
}

function endOfYearMs(year) {
  return Date.UTC(year, 11, 31, 23, 59, 59, 999);
}

/**
 * Holding period in whole days between acquisition and disposal.
 * @returns {number}
 */
export function holdingPeriodDays(acquiredAt, disposedAt) {
  return Math.floor((toMs(disposedAt) - toMs(acquiredAt)) / DAY_MS);
}

/**
 * Whether a disposal qualifies for long-term capital-gains treatment.
 * @returns {boolean}
 */
export function isLongTerm(acquiredAt, disposedAt) {
  return holdingPeriodDays(acquiredAt, disposedAt) > LONG_TERM_HOLDING_DAYS;
}

/**
 * Realised gain (positive) or loss (negative) for a single disposal.
 * @param {{ proceeds: number, costBasis: number }} disposal
 * @returns {number}
 */
export function computeGain({ proceeds, costBasis }) {
  if (!Number.isFinite(proceeds) || !Number.isFinite(costBasis)) {
    throw new TypeError("proceeds and costBasis must be finite numbers");
  }
  return proceeds - costBasis;
}

/**
 * Classify a disposal as short- or long-term.
 * @returns {{ gain: number, term: "short" | "long", holdingDays: number }}
 */
export function classifyDisposal(disposal) {
  const gain = computeGain(disposal);
  const holdingDays = holdingPeriodDays(disposal.acquiredAt, disposal.disposedAt);
  return { gain, term: holdingDays > LONG_TERM_HOLDING_DAYS ? "long" : "short", holdingDays };
}

/**
 * Detect wash sales: a loss sale is disallowed when the same asset was bought
 * within `windowDays` before or after the sale.
 *
 * @param {{ sales: object[], purchases: object[] }} input
 * @param {{ windowDays?: number }} [options]
 * @returns {Array<{ sale: object, matchedPurchase: object, disallowedLoss: number }>}
 */
export function detectWashSales(input, options = {}) {
  const windowDays = options.windowDays ?? WASH_SALE_WINDOW_DAYS;
  const windowMs = windowDays * DAY_MS;
  const sales = input.sales ?? [];
  const purchases = input.purchases ?? [];

  const matches = [];
  for (const sale of sales) {
    const loss = computeGain(sale);
    if (loss >= 0) continue; // wash sale only applies to losses

    const soldAt = toMs(sale.disposedAt);
    const replacement = purchases.find((purchase) => {
      if (purchase.asset && sale.asset && purchase.asset !== sale.asset) return false;
      const boughtAt = toMs(purchase.purchasedAt);
      return Math.abs(boughtAt - soldAt) <= windowMs;
    });

    if (replacement) {
      matches.push({ sale, matchedPurchase: replacement, disallowedLoss: Math.abs(loss) });
    }
  }
  return matches;
}

/**
 * Estimate total capital-gains tax across disposals.
 *
 * @param {object[]} disposals
 * @param {{ rates?: { shortTerm: number, longTerm: number }, washSales?: object[] }} [options]
 * @returns {{ shortTermGains: number, longTermGains: number, disallowedLosses: number,
 *            taxableShortTerm: number, taxableLongTerm: number, shortTermTax: number,
 *            longTermTax: number, totalTax: number, netGain: number }}
 */
export function estimateTaxLiability(disposals, options = {}) {
  const rates = { ...DEFAULT_TAX_RATES, ...(options.rates ?? {}) };
  const washSales = options.washSales ?? [];

  let shortTermGains = 0;
  let longTermGains = 0;
  let disallowedLosses = 0;

  for (const disposal of disposals) {
    const { gain, term } = classifyDisposal(disposal);
    if (term === "long") longTermGains += gain;
    else shortTermGains += gain;
  }

  for (const match of washSales) {
    // A disallowed loss cannot offset gains; add it back to the relevant term.
    const { term } = classifyDisposal(match.sale);
    disallowedLosses += match.disallowedLoss;
    if (term === "long") longTermGains += match.disallowedLoss;
    else shortTermGains += match.disallowedLoss;
  }

  // Losses offset gains across terms before rates are applied.
  const netGain = shortTermGains + longTermGains;
  const taxableShortTerm = Math.max(0, shortTermGains);
  const taxableLongTerm = Math.max(0, longTermGains);
  const shortTermTax = taxableShortTerm * rates.shortTerm;
  const longTermTax = taxableLongTerm * rates.longTerm;

  return {
    shortTermGains,
    longTermGains,
    disallowedLosses,
    taxableShortTerm,
    taxableLongTerm,
    shortTermTax,
    longTermTax,
    totalTax: shortTermTax + longTermTax,
    netGain,
  };
}

/**
 * Recommend when to dispose of each open position.
 *
 * Decision order (deterministic):
 *  1. Unrealised loss → `harvest-loss` (realise the offsetting loss), unless a
 *     purchase inside the wash-sale window already blocks it.
 *  2. Unrealised short-term gain that becomes long-term in the future →
 *     `wait-for-long-term` when the rate saving beats the wait.
 *  3. Otherwise, if within `yearEndDeferralDays` of year end → `defer-to-next-year`.
 *  4. Otherwise → `sell-now`.
 *
 * @param {object[]} holdings - `{ asset, acquiredAt, currentValue, costBasis }`
 * @param {object} [options] - `{ asOf, rates, yearEndDeferralDays, purchases }`
 * @returns {object[]} recommendations sorted by estimated savings, desc
 */
export function recommendWithdrawalTiming(holdings, options = {}) {
  const rates = { ...DEFAULT_TAX_RATES, ...(options.rates ?? {}) };
  const asOf = toMs(options.asOf ?? Date.now());
  const deferralDays = options.yearEndDeferralDays ?? YEAR_END_DEFERRAL_DAYS;
  const purchases = options.purchases ?? [];

  const taxYear = new Date(asOf).getUTCFullYear();
  const yearEnd = endOfYearMs(taxYear);
  const daysToYearEnd = Math.floor((yearEnd - asOf) / DAY_MS);

  const recommendations = holdings.map((holding) => {
    const gain = computeGain({
      proceeds: holding.currentValue,
      costBasis: holding.costBasis,
    });
    const term = isLongTerm(holding.acquiredAt, asOf) ? "long" : "short";
    const rate = term === "long" ? rates.longTerm : rates.shortTerm;

    if (gain <= 0) {
      const blocked =
        detectWashSales(
          {
            sales: [
              {
                asset: holding.asset,
                disposedAt: asOf,
                proceeds: holding.currentValue,
                costBasis: holding.costBasis,
              },
            ],
            purchases,
          },
          {}
        ).length > 0;

      return {
        asset: holding.asset,
        action: blocked ? "hold" : "harvest-loss",
        reason: blocked
          ? "Loss cannot be harvested: a purchase sits inside the wash-sale window"
          : "Realise the loss to offset gains",
        estimatedTaxNow: gain * rate,
        estimatedTaxLater: 0,
        savings: blocked ? 0 : Math.abs(gain) * rate,
        suggestedDate: asOf,
      };
    }

    if (term === "short") {
      const longTermDate = toMs(holding.acquiredAt) + (LONG_TERM_HOLDING_DAYS + 1) * DAY_MS;
      const savings = gain * (rates.shortTerm - rates.longTerm);
      if (longTermDate > asOf && savings > 0) {
        return {
          asset: holding.asset,
          action: "wait-for-long-term",
          reason: "Waiting converts a short-term gain into long-term treatment",
          estimatedTaxNow: gain * rates.shortTerm,
          estimatedTaxLater: gain * rates.longTerm,
          savings,
          suggestedDate: longTermDate,
        };
      }
    }

    if (daysToYearEnd <= deferralDays) {
      const nextYearStart = Date.UTC(taxYear + 1, 0, 2);
      return {
        asset: holding.asset,
        action: "defer-to-next-year",
        reason: "Disposing after year end shifts the gain into the next tax year",
        estimatedTaxNow: gain * rate,
        estimatedTaxLater: gain * rate,
        savings: 0,
        suggestedDate: nextYearStart,
      };
    }

    return {
      asset: holding.asset,
      action: "sell-now",
      reason: "No timing advantage remains for this position",
      estimatedTaxNow: gain * rate,
      estimatedTaxLater: gain * rate,
      savings: 0,
      suggestedDate: asOf,
    };
  });

  return recommendations.sort((a, b) => b.savings - a.savings);
}
