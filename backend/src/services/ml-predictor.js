/**
 * Deterministic, bounded royalty-rate predictor.
 *
 * This is the local inference boundary for the production ML model. A hosted
 * model can replace predictRoyaltyRate without changing the oracle contract:
 * inputs are normalized market features and output is basis points.
 */
export function predictRoyaltyRate({ floorPrice, volume, supply, creatorTier = 1 }) {
  const floor = Number.isFinite(Number(floorPrice)) ? Math.max(0, Number(floorPrice)) : 0;
  const trades = Number.isFinite(Number(volume)) ? Math.max(0, Number(volume)) : 0;
  const available = Number.isFinite(Number(supply)) ? Math.max(1, Number(supply)) : 1;
  const tier = Math.min(5, Math.max(1, Number(creatorTier) || 1));

  // Log-scaled features keep a single whale sale from dominating the result.
  const demand = Math.min(1, Math.log1p(trades) / Math.log1p(1000));
  const scarcity = Math.max(0, 1 - Math.min(1, available / 10_000));
  const floorSignal = Math.min(1, Math.log1p(floor) / Math.log1p(100_000));
  const tierSignal = (tier - 1) / 4;
  const score = 0.35 * demand + 0.25 * scarcity + 0.25 * floorSignal + 0.15 * tierSignal;
  const rate = Math.round(250 + score * 1_750);
  return Math.max(100, Math.min(2_000, rate));
}

export function explainPrediction(features) {
  const recommendedRate = predictRoyaltyRate(features);
  return {
    recommendedRate,
    bounds: { min: 100, max: 2_000 },
    model: "bounded-log-linear-v1",
    features: {
      floorPrice: Number(features.floorPrice) || 0,
      volume: Number(features.volume) || 0,
      supply: Number(features.supply) || 1,
      creatorTier: Number(features.creatorTier) || 1,
    },
  };
}
