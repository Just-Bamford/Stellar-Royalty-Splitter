# Tax Optimization & DeFi Strategy Recommendations

> **Status:** Aspirational / Future Work — This documents planned features for issue #1040.
> Backend services (`tax-optimizer.js`, `defi-strategies.js`) are not yet implemented.
>
> Values are numbers in a single unit (e.g. US cents); the engine never mixes assets.
> Guidance only — not filing software.

## Tax optimizer (`backend/src/services/tax-optimizer.js`)

| Function                                                          | Purpose                                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------- |
| `holdingPeriodDays(acquiredAt, disposedAt)`                       | Whole days held                                           |
| `isLongTerm(acquiredAt, disposedAt)`                              | Long-term when held **> 365 days** (366+)                 |
| `computeGain({ proceeds, costBasis })`                            | Realised gain (positive) / loss (negative)                |
| `classifyDisposal(disposal)`                                      | `{ gain, term, holdingDays }`                             |
| `detectWashSales({ sales, purchases })`                           | Loss sales with a same-asset purchase within **±30 days** |
| `estimateTaxLiability(disposals, { rates, washSales })`           | Short/long breakdown + tax, adding disallowed losses back |
| `recommendWithdrawalTiming(holdings, { asOf, rates, purchases })` | Per-position timing action, sorted by savings             |

### Decision order

1. **Unrealised loss** → `harvest-loss` (or `hold` if a purchase blocks it via the wash-sale window).
2. **Short-term gain that becomes long-term in future** → `wait-for-long-term` when the rate saving is positive.
3. **Within 45 days of year end** → `defer-to-next-year` to shift the gain into the next tax year.
4. Otherwise → `sell-now`.

Default rates approximate a top US bracket (`shortTerm = 0.37`, `longTerm = 0.20`)
and are overridable per call. Assumptions live in the module JSDoc.

## DeFi strategies (`backend/src/services/defi-strategies.js`)

- `recommendStrategies({ riskTolerance, horizonDays, amountUsd, excludeIds })`
  filters the static `STRATEGY_CATALOG` by the tolerance's max risk level and by
  lockup ≤ horizon, projects compounded returns, and sorts best-first.
- `projectReturns(strategy, { amountUsd, horizonDays })` — simple and daily-compounded.
- `allocatePortfolio(recommendations, { amountUsd, allocations })` — per-strategy
  slices and blended APY.

The catalogue is a deterministic snapshot so recommendations are reproducible;
production would refresh APYs from `price-oracle.js`.

## Out of scope

Frontend dashboard (`frontend/src/components/TaxOptimization.tsx`) and tax filing
integration are follow-ups.
