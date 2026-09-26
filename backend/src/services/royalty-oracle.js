import { explainPrediction } from "./ml-predictor.js";

const collections = new Map();
const recommendations = new Map();

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function collectMarketData(collectionId, fetcher = null) {
  if (!collectionId) throw new Error("collectionId is required");
  const data = fetcher
    ? await fetcher(collectionId)
    : {
        floorPrice: numeric(process.env.ORACLE_DEFAULT_FLOOR_PRICE),
        volume: numeric(process.env.ORACLE_DEFAULT_VOLUME),
        supply: Math.max(1, numeric(process.env.ORACLE_DEFAULT_SUPPLY, 1)),
        source: "configured-default",
      };
  const snapshot = {
    collectionId,
    floorPrice: Math.max(0, numeric(data.floorPrice)),
    volume: Math.max(0, numeric(data.volume)),
    supply: Math.max(1, numeric(data.supply, 1)),
    creatorTier: Math.max(1, numeric(data.creatorTier, 1)),
    source: data.source ?? "market-adapter",
    collectedAt: new Date().toISOString(),
  };
  collections.set(collectionId, snapshot);
  const prediction = explainPrediction(snapshot);
  const recommendation = {
    collectionId,
    ...prediction,
    status: "pending",
    createdAt: snapshot.collectedAt,
  };
  recommendations.set(collectionId, recommendation);
  return recommendation;
}

export function getRecommendation(collectionId) {
  return recommendations.get(collectionId) ?? null;
}

export function listRecommendations() {
  return [...recommendations.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function approveRecommendation(collectionId, approvedBy, approved = true) {
  const recommendation = recommendations.get(collectionId);
  if (!recommendation) throw new Error("No oracle recommendation exists for this collection");
  const updated = {
    ...recommendation,
    status: approved ? "approved" : "rejected",
    approvedBy,
    approvedAt: new Date().toISOString(),
  };
  recommendations.set(collectionId, updated);
  return updated;
}

export function getMarketSnapshot(collectionId) {
  return collections.get(collectionId) ?? null;
}

export function startOracleScheduler({ intervalMs = 7 * 24 * 60 * 60 * 1000, collections: ids = [] } = {}) {
  if (!ids.length) return { stop: () => {} };
  const run = () => Promise.allSettled(ids.map((id) => collectMarketData(id)));
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
