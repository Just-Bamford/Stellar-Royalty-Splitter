const metrics = {
  distributeCallsTotal: 0,
  transactionsSuccessfulTotal: 0,
  transactionsFailedTotal: 0,
  horizonResponseTimeMsTotal: 0,
  horizonResponseTimeCount: 0,
};

function formatMetricValue(value) {
  return Number.isFinite(value) ? value : 0;
}

export function recordDistributeCall() {
  metrics.distributeCallsTotal += 1;
}

export function recordTransactionSuccess() {
  metrics.transactionsSuccessfulTotal += 1;
}

export function recordTransactionFailure() {
  metrics.transactionsFailedTotal += 1;
}

export function recordHorizonResponseTime(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  metrics.horizonResponseTimeMsTotal += durationMs;
  metrics.horizonResponseTimeCount += 1;
}

export function getMetricsSnapshot() {
  const averageHorizonResponseTimeMs =
    metrics.horizonResponseTimeCount === 0
      ? 0
      : metrics.horizonResponseTimeMsTotal / metrics.horizonResponseTimeCount;

  return {
    ...metrics,
    averageHorizonResponseTimeMs,
  };
}

export function prometheusMetrics() {
  let cacheMetrics = { hits: 0, misses: 0, hitRatio: 0, size: 0 };
  try {
    // Lazy import avoids circular deps; cache.js is optional at metrics time
    const cache = globalThis.__cacheModule;
    if (cache) cacheMetrics = cache.getCacheMetrics();
  } catch {/* ignore */}

  const snapshot = getMetricsSnapshot();

  return [
    "# HELP stellar_distribute_calls_total Total distribute endpoint calls.",
    "# TYPE stellar_distribute_calls_total counter",
    `stellar_distribute_calls_total ${snapshot.distributeCallsTotal}`,
    "# HELP stellar_transactions_successful_total Successful distribute transactions built by the API.",
    "# TYPE stellar_transactions_successful_total counter",
    `stellar_transactions_successful_total ${snapshot.transactionsSuccessfulTotal}`,
    "# HELP stellar_transactions_failed_total Failed distribute transaction build attempts.",
    "# TYPE stellar_transactions_failed_total counter",
    `stellar_transactions_failed_total ${snapshot.transactionsFailedTotal}`,
    "# HELP stellar_horizon_response_time_average_ms Average Horizon response time in milliseconds.",
    "# TYPE stellar_horizon_response_time_average_ms gauge",
    `stellar_horizon_response_time_average_ms ${formatMetricValue(
      snapshot.averageHorizonResponseTimeMs,
    )}`,
    "# HELP stellar_horizon_response_time_count Horizon response time observations.",
    "# TYPE stellar_horizon_response_time_count counter",
    `stellar_horizon_response_time_count ${snapshot.horizonResponseTimeCount}`,
    "# HELP stellar_cache_hits_total Total cache hits.",
    "# TYPE stellar_cache_hits_total counter",
    `stellar_cache_hits_total ${cacheMetrics.hits}`,
    "# HELP stellar_cache_misses_total Total cache misses.",
    "# TYPE stellar_cache_misses_total counter",
    `stellar_cache_misses_total ${cacheMetrics.misses}`,
    "# HELP stellar_cache_hit_ratio Cache hit ratio (0-1).",
    "# TYPE stellar_cache_hit_ratio gauge",
    `stellar_cache_hit_ratio ${formatMetricValue(cacheMetrics.hitRatio)}`,
    "# HELP stellar_cache_size Current number of cached entries.",
    "# TYPE stellar_cache_size gauge",
    `stellar_cache_size ${cacheMetrics.size}`,
    "",
  ].join("\n");
}

export function resetMetrics() {
  metrics.distributeCallsTotal = 0;
  metrics.transactionsSuccessfulTotal = 0;
  metrics.transactionsFailedTotal = 0;
  metrics.horizonResponseTimeMsTotal = 0;
  metrics.horizonResponseTimeCount = 0;
}
