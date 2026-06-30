/**
 * In-memory metrics store (#396).
 *
 * Tracks:
 *   - Distribute call totals (existing)
 *   - Transaction success/failure totals (existing)
 *   - Horizon response time average (existing)
 *   - HTTP request counts by method+path+status (#396)
 *   - HTTP response time observations for p50/p95/p99 latency (#396)
 *   - Stellar RPC call counts by operation (#396)
 *   - Request/response size totals (#396)
 */

const metrics = {
  // ── Existing counters ──────────────────────────────────────────────────
  distributeCallsTotal: 0,
  transactionsSuccessfulTotal: 0,
  transactionsFailedTotal: 0,
  horizonResponseTimeMsTotal: 0,
  horizonResponseTimeCount: 0,
  rejectedRequestsTotal: 0,
  trackedTransactionsTotal: 0,

  // ── #396: HTTP request tracking ───────────────────────────────────────
  /** Map<"METHOD /path status"> → count */
  httpRequestCounts: new Map(),
  /** All response time observations in ms, kept for percentile calculation */
  responseTimeObservations: [],
  /** Total request body bytes received */
  requestBytesTotal: 0,
  /** Total response body bytes sent */
  responseBytesTotal: 0,

  // ── #396: Stellar RPC tracing ─────────────────────────────────────────
  /** Map<operationLabel> → { count, totalMs } */
  stellarRpcCalls: new Map(),

  // ── #422: RPC response cache hit/miss tracking ─────────────────────────
  /** Map<cacheName> → { hits, misses } */
  cacheStats: new Map(),

  // #510: Contract state consistency verification
  contractConsistencyChecksTotal: 0,
  contractConsistencyFailuresTotal: 0,
  contractConsistencyDiscrepanciesTotal: 0,
  contractConsistencyLastDiscrepancyCount: 0,
  contractConsistencyLastRunTimestamp: 0,
};

// ── Helpers ──────────────────────────────────────────────────────────────

function formatMetricValue(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Calculate a percentile value from a sorted (ascending) array.
 * Returns 0 for empty arrays.
 */
function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}

// ── Existing recorders ───────────────────────────────────────────────────

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

export function recordRejectedRequest() {
  metrics.rejectedRequestsTotal += 1;
}

export function recordTrackedTransaction() {
  metrics.trackedTransactionsTotal += 1;
}

// ── #396: New recorders ───────────────────────────────────────────────────

/**
 * Record an HTTP request completion.
 *
 * @param {string} method  - HTTP method (GET, POST, …)
 * @param {string} path    - Normalised route path (e.g. /api/v1/distribute)
 * @param {number} status  - HTTP status code
 * @param {number} durationMs - Response time in milliseconds
 * @param {object} [sizes] - Optional { requestBytes, responseBytes }
 */
export function recordHttpRequest(method, path, status, durationMs, sizes = {}) {
  const key = `${method} ${path} ${status}`;
  metrics.httpRequestCounts.set(key, (metrics.httpRequestCounts.get(key) ?? 0) + 1);

  if (Number.isFinite(durationMs) && durationMs >= 0) {
    metrics.responseTimeObservations.push(durationMs);
  }

  if (Number.isFinite(sizes.requestBytes) && sizes.requestBytes >= 0) {
    metrics.requestBytesTotal += sizes.requestBytes;
  }
  if (Number.isFinite(sizes.responseBytes) && sizes.responseBytes >= 0) {
    metrics.responseBytesTotal += sizes.responseBytes;
  }
}

/**
 * Record a Stellar RPC call (prepareTransaction, getAccount, simulateTransaction, etc.).
 *
 * @param {string} operation  - Human-readable label, e.g. "Soroban prepareTransaction"
 * @param {number} durationMs - How long the call took
 * @param {boolean} [success=true]
 */
export function recordStellarRpcCall(operation, durationMs, success = true) {
  const entry = metrics.stellarRpcCalls.get(operation) ?? {
    count: 0,
    successCount: 0,
    failureCount: 0,
    totalMs: 0,
  };
  entry.count += 1;
  if (success) {
    entry.successCount += 1;
  } else {
    entry.failureCount += 1;
  }
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    entry.totalMs += durationMs;
  }
  metrics.stellarRpcCalls.set(operation, entry);
}

// ── #422: Cache hit/miss recorders ──────────────────────────────────────

function getCacheEntry(cacheName) {
  const entry = metrics.cacheStats.get(cacheName) ?? { hits: 0, misses: 0 };
  metrics.cacheStats.set(cacheName, entry);
  return entry;
}

export function recordCacheHit(cacheName) {
  getCacheEntry(cacheName).hits += 1;
}

export function recordCacheMiss(cacheName) {
  getCacheEntry(cacheName).misses += 1;
}

export function recordContractConsistencyCheck({ success, discrepancyCount = 0 } = {}) {
  const count = Number.isFinite(discrepancyCount) ? Math.max(0, discrepancyCount) : 0;

  metrics.contractConsistencyChecksTotal += 1;
  metrics.contractConsistencyLastRunTimestamp = Math.floor(Date.now() / 1000);
  metrics.contractConsistencyLastDiscrepancyCount = count;
  metrics.contractConsistencyDiscrepanciesTotal += count;

  if (!success) {
    metrics.contractConsistencyFailuresTotal += 1;
  }
}

// ── Snapshot ──────────────────────────────────────────────────────────────

export function getMetricsSnapshot() {
  const averageHorizonResponseTimeMs =
    metrics.horizonResponseTimeCount === 0
      ? 0
      : metrics.horizonResponseTimeMsTotal / metrics.horizonResponseTimeCount;

  const sorted = [...metrics.responseTimeObservations].sort((a, b) => a - b);

  return {
    // Existing
    distributeCallsTotal: metrics.distributeCallsTotal,
    transactionsSuccessfulTotal: metrics.transactionsSuccessfulTotal,
    transactionsFailedTotal: metrics.transactionsFailedTotal,
    horizonResponseTimeMsTotal: metrics.horizonResponseTimeMsTotal,
    horizonResponseTimeCount: metrics.horizonResponseTimeCount,
    averageHorizonResponseTimeMs,
    rejectedRequestsTotal: metrics.rejectedRequestsTotal,
    trackedTransactionsTotal: metrics.trackedTransactionsTotal,

    // #396
    httpRequestCounts: Object.fromEntries(metrics.httpRequestCounts),
    responseTimeP50Ms: percentile(sorted, 50),
    responseTimeP95Ms: percentile(sorted, 95),
    responseTimeP99Ms: percentile(sorted, 99),
    responseTimeObservationCount: sorted.length,
    requestBytesTotal: metrics.requestBytesTotal,
    responseBytesTotal: metrics.responseBytesTotal,
    stellarRpcCalls: Object.fromEntries(
      [...metrics.stellarRpcCalls.entries()].map(([op, v]) => [
        op,
        { ...v, averageMs: v.count > 0 ? v.totalMs / v.count : 0 },
      ]),
    ),

    // #422
    cacheStats: Object.fromEntries(metrics.cacheStats),

    // #510
    contractConsistencyChecksTotal: metrics.contractConsistencyChecksTotal,
    contractConsistencyFailuresTotal: metrics.contractConsistencyFailuresTotal,
    contractConsistencyDiscrepanciesTotal: metrics.contractConsistencyDiscrepanciesTotal,
    contractConsistencyLastDiscrepancyCount:
      metrics.contractConsistencyLastDiscrepancyCount,
    contractConsistencyLastRunTimestamp: metrics.contractConsistencyLastRunTimestamp,
  };
}

// ── Prometheus text format ────────────────────────────────────────────────

export function prometheusMetrics() {
  const snapshot = getMetricsSnapshot();

  const lines = [
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
    `stellar_horizon_response_time_average_ms ${formatMetricValue(snapshot.averageHorizonResponseTimeMs)}`,
    "# HELP stellar_tracked_transactions_total Total number of tracked request transactions.",
    "# TYPE stellar_tracked_transactions_total counter",
    `stellar_tracked_transactions_total ${snapshot.trackedTransactionsTotal}`,
    "# HELP stellar_horizon_response_time_count Horizon response time observations.",
    "# TYPE stellar_horizon_response_time_count counter",
    `stellar_horizon_response_time_count ${snapshot.horizonResponseTimeCount}`,

    // #396 — latency percentiles
    "# HELP stellar_http_response_time_p50_ms 50th-percentile HTTP response time.",
    "# TYPE stellar_http_response_time_p50_ms gauge",
    `stellar_http_response_time_p50_ms ${formatMetricValue(snapshot.responseTimeP50Ms)}`,
    "# HELP stellar_http_response_time_p95_ms 95th-percentile HTTP response time.",
    "# TYPE stellar_http_response_time_p95_ms gauge",
    `stellar_http_response_time_p95_ms ${formatMetricValue(snapshot.responseTimeP95Ms)}`,
    "# HELP stellar_http_response_time_p99_ms 99th-percentile HTTP response time.",
    "# TYPE stellar_http_response_time_p99_ms gauge",
    `stellar_http_response_time_p99_ms ${formatMetricValue(snapshot.responseTimeP99Ms)}`,
    "# HELP stellar_http_response_time_observations_total Number of HTTP response time samples.",
    "# TYPE stellar_http_response_time_observations_total counter",
    `stellar_http_response_time_observations_total ${snapshot.responseTimeObservationCount}`,

    // #396 — traffic volume
    "# HELP stellar_http_request_bytes_total Total request body bytes received.",
    "# TYPE stellar_http_request_bytes_total counter",
    `stellar_http_request_bytes_total ${snapshot.requestBytesTotal}`,
    "# HELP stellar_http_response_bytes_total Total response body bytes sent.",
    "# TYPE stellar_http_response_bytes_total counter",
    `stellar_http_response_bytes_total ${snapshot.responseBytesTotal}`,
  ];

  // #396 — per-route HTTP counters
  lines.push(
    "# HELP stellar_http_requests_total HTTP requests by method, path and status.",
    "# TYPE stellar_http_requests_total counter",
  );
  for (const [key, count] of Object.entries(snapshot.httpRequestCounts)) {
    const [method, path, status] = key.split(" ");
    lines.push(
      `stellar_http_requests_total{method="${method}",path="${path}",status="${status}"} ${count}`,
    );
  }

  // #396 — Stellar RPC call counters
  lines.push(
    "# HELP stellar_rpc_calls_total Stellar RPC calls by operation.",
    "# TYPE stellar_rpc_calls_total counter",
    "# HELP stellar_rpc_call_duration_ms_average Average Stellar RPC call duration by operation.",
    "# TYPE stellar_rpc_call_duration_ms_average gauge",
  );
  for (const [op, v] of Object.entries(snapshot.stellarRpcCalls)) {
    const label = `operation="${op}"`;
    lines.push(
      `stellar_rpc_calls_total{${label}} ${v.count}`,
      `stellar_rpc_calls_total{${label},result="success"} ${v.successCount}`,
      `stellar_rpc_calls_total{${label},result="failure"} ${v.failureCount}`,
      `stellar_rpc_call_duration_ms_average{${label}} ${formatMetricValue(v.averageMs)}`,
    );
  }

  // #422 — cache hit/miss counters
  lines.push(
    "# HELP stellar_cache_hits_total Cache hits by cache name.",
    "# TYPE stellar_cache_hits_total counter",
  );
  for (const [cache, v] of Object.entries(snapshot.cacheStats)) {
    lines.push(`stellar_cache_hits_total{cache="${cache}"} ${v.hits}`);
  }
  lines.push(
    "# HELP stellar_cache_misses_total Cache misses by cache name.",
    "# TYPE stellar_cache_misses_total counter",
  );
  for (const [cache, v] of Object.entries(snapshot.cacheStats)) {
    lines.push(`stellar_cache_misses_total{cache="${cache}"} ${v.misses}`);
  }

  // #510 — contract state consistency alerts
  lines.push(
    "# HELP stellar_contract_consistency_checks_total Contract state consistency verification runs.",
    "# TYPE stellar_contract_consistency_checks_total counter",
    `stellar_contract_consistency_checks_total ${snapshot.contractConsistencyChecksTotal}`,
    "# HELP stellar_contract_consistency_failures_total Contract state consistency verification runs that failed before comparison completed.",
    "# TYPE stellar_contract_consistency_failures_total counter",
    `stellar_contract_consistency_failures_total ${snapshot.contractConsistencyFailuresTotal}`,
    "# HELP stellar_contract_consistency_discrepancies_total Total DB versus on-chain state discrepancies found.",
    "# TYPE stellar_contract_consistency_discrepancies_total counter",
    `stellar_contract_consistency_discrepancies_total ${snapshot.contractConsistencyDiscrepanciesTotal}`,
    "# HELP stellar_contract_consistency_last_discrepancy_count Discrepancies found during the latest consistency verification run.",
    "# TYPE stellar_contract_consistency_last_discrepancy_count gauge",
    `stellar_contract_consistency_last_discrepancy_count ${snapshot.contractConsistencyLastDiscrepancyCount}`,
    "# HELP stellar_contract_consistency_last_run_timestamp_seconds Unix timestamp for the latest consistency verification run.",
    "# TYPE stellar_contract_consistency_last_run_timestamp_seconds gauge",
    `stellar_contract_consistency_last_run_timestamp_seconds ${snapshot.contractConsistencyLastRunTimestamp}`,
  );

  lines.push("");
  return lines.join("\n");
}

// ── Reset (tests) ─────────────────────────────────────────────────────────

export function resetMetrics() {
  metrics.distributeCallsTotal = 0;
  metrics.transactionsSuccessfulTotal = 0;
  metrics.transactionsFailedTotal = 0;
  metrics.horizonResponseTimeMsTotal = 0;
  metrics.horizonResponseTimeCount = 0;
  metrics.rejectedRequestsTotal = 0;
  metrics.trackedTransactionsTotal = 0;
  metrics.httpRequestCounts.clear();
  metrics.responseTimeObservations.length = 0;
  metrics.requestBytesTotal = 0;
  metrics.responseBytesTotal = 0;
  metrics.stellarRpcCalls.clear();
  metrics.cacheStats.clear();
  metrics.contractConsistencyChecksTotal = 0;
  metrics.contractConsistencyFailuresTotal = 0;
  metrics.contractConsistencyDiscrepanciesTotal = 0;
  metrics.contractConsistencyLastDiscrepancyCount = 0;
  metrics.contractConsistencyLastRunTimestamp = 0;
}
