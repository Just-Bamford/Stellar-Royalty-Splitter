import { getMaterializedSnapshot, refreshMaterializedViews } from "../database/materialized-views.js";
import { evaluateAnalyticsAlerts } from "./anomaly-detection.js";

const cache = new Map();
const CACHE_TTL_MS = 30_000;

export function getAdvancedAnalytics(contractId, options = {}) {
  const key = `${contractId}:${options.hours ?? 24}:${options.days ?? 30}`;
  const cached = cache.get(key);
  if (!options.refresh && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;
  refreshMaterializedViews(contractId);
  const snapshot = getMaterializedSnapshot(contractId, options);
  const anomalies = evaluateAnalyticsAlerts(snapshot, options.onAlert, options.thresholds);
  const data = { contractId, generatedAt: new Date().toISOString(), ...snapshot, anomalies };
  cache.set(key, { timestamp: Date.now(), data });
  return data;
}

export function clearAnalyticsCache() {
  cache.clear();
}
