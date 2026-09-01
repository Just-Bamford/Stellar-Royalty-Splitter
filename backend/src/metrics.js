import client from "prom-client";
import http from "http";
import https from "https";

const metrics = {
  distributeCallsTotal: 0,
  transactionsSuccessfulTotal: 0,
  transactionsFailedTotal: 0,
  horizonResponseTimeMsTotal: 0,
  horizonResponseTimeCount: 0,
  // DoS protection counters (#426)
  oversizedRequestsRejectedTotal: 0,
  dosRateLimitedTotal: 0,
  // Detailed health check component response times (#423)
  healthCheckDatabaseResponseTimeMs: 0,
  healthCheckHorizonResponseTimeMs: 0,
  healthCheckSorobanResponseTimeMs: 0,
  healthCheckCacheResponseTimeMs: 0,
  healthCheckTotal: 0,
  // RPC retry tracking (transient-failure retry strategy)
  rpcRetryAttempts: 0,
  rpcRetrySuccesses: 0,
  rpcRetryExhausted: 0,
  // Connection health monitoring (#496)
  connectionHealthTotalChecks: 0,
  connectionHealthTotalFailures: 0,
  connectionHealthConsecutiveFailures: 0,
  connectionHealthLastCheckDurationMs: 0,
  connectionHealthReconnectionsAttempted: 0,
  connectionHealthReconnectionsSucceeded: 0,
  connectionHealthReconnectionsFailed: 0,
  connectionHealthPoolUtilization: 0,
};

// Comprehensive Prometheus metrics (#816)
const register = new client.Registry();
client.collectDefaultMetrics({ register });

// HTTP request metrics used by the operational dashboard and alert rules.
const httpRequests = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled by the API",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

// Counter for function invocations
const contractFunctionDuration = new client.Histogram({
  name: "stellar_contract_function_duration_seconds",
  help: "Duration of contract function calls in seconds",
  labelNames: ["contractId", "functionName"],
  registers: [register],
});

// Counter for RPC operations
const rpcOperationDuration = new client.Histogram({
  name: "stellar_rpc_operation_duration_seconds",
  help: "Duration of Soroban RPC operations in seconds",
  labelNames: ["operationType"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

// Database query duration
const dbQueryDuration = new client.Histogram({
  name: "stellar_db_query_duration_seconds",
  help: "Duration of database queries in seconds",
  labelNames: ["queryType"],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
  registers: [register],
});

// Cache hit/miss counters
const cacheHits = new client.Counter({
  name: "stellar_cache_hits_total",
  help: "Total cache hits",
  labelNames: ["namespace"],
  registers: [register],
});

const cacheMisses = new client.Counter({
  name: "stellar_cache_misses_total",
  help: "Total cache misses",
  labelNames: ["namespace"],
  registers: [register],
});

// Rate limiter metrics
const rateLimitHits = new client.Counter({
  name: "stellar_rate_limit_hits_total",
  help: "Total rate limit hits",
  labelNames: ["dimension"],
  registers: [register],
});

// Active connections gauge
const activeConnections = new client.Gauge({
  name: "stellar_active_connections",
  help: "Number of active database connections",
  registers: [register],
});

// RPC retry tracking (centralized transient-failure retry strategy)
const rpcRetryAttempts = new client.Counter({
  name: "stellar_rpc_retries_total",
  help: "Total RPC retry attempts executed after a transient failure",
  labelNames: ["operationType"],
  registers: [register],
});

const rpcRetrySuccesses = new client.Counter({
  name: "stellar_rpc_retry_successes_total",
  help: "Total RPC operations that succeeded after at least one retry",
  labelNames: ["operationType"],
  registers: [register],
});

const rpcRetryExhausted = new client.Counter({
  name: "stellar_rpc_retry_exhausted_total",
  help: "Total RPC operations that failed after exhausting all retries",
  labelNames: ["operationType"],
  registers: [register],
});

// Alerting metrics
const alertsTriggered = new client.Counter({
  name: "stellar_alerts_triggered_total",
  help: "Total alert rules triggered",
  labelNames: ["contractId", "type"],
  registers: [register],
});

// Alerting constants
const ALERT_WINDOW_MS = 5 * 60 * 1000;
const ALERT_HISTORY_MS = 60 * 60 * 1000;
const MAX_BUCKETS = Math.ceil(ALERT_HISTORY_MS / ALERT_WINDOW_MS);
const DEFAULT_ERROR_RATE_THRESHOLD = 0.10;
const DEFAULT_MIN_TOTAL = 10;
const DEFAULT_DEDUPE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX_LATENCY_MS = 5000;
const DEFAULT_ANOMALY_ZSCORE = 3.5;

const contractMetrics = new Map();
const alertRules = new Map();
const alertState = new Map();
let alertTimer = null;

function formatMetricValue(value) {
  return Number.isFinite(value) ? value : 0;
}

function getContractMetrics(contractId) {
  if (!contractMetrics.has(contractId)) {
    contractMetrics.set(contractId, {
      buckets: [],
      totals: { distributions: 0, successful: 0, failed: 0 },
      amounts: [],
      tokens: new Set(),
      latencies: [],
    });
  }
  return contractMetrics.get(contractId);
}

function updateContractMetrics(contractId, success, meta = {}) {
  const m = getContractMetrics(contractId);
  const now = Date.now();
  let bucket = m.buckets.length > 0 ? m.buckets[m.buckets.length - 1] : null;
  if (!bucket || now - bucket.start >= ALERT_WINDOW_MS) {
    bucket = { start: now, total: 0, failed: 0 };
    m.buckets.push(bucket);
    const cutoff = now - ALERT_HISTORY_MS;
    while (m.buckets.length > 0 && m.buckets[0].start < cutoff) {
      m.buckets.shift();
    }
    if (m.buckets.length > MAX_BUCKETS ) m.buckets.shift();
  }
  bucket.total += 1;
  m.totals.distributions += 1;
  if (success) m.totals.successful += 1;
  else {
    m.totals.failed += 1;
    bucket.failed += 1;
  }
  if (Number.isFinite(meta.amount)) m.amounts.push(meta.amount);
  if (meta.token) m.tokens.add(meta.token);
  if (Number.isFinite(meta.latencyMs) && meta.latencyMs >= 0) m.latencies.push(meta.latencyMs);
  return m;
}

function getErrorRateInWindow(contractId) {
  const m = contractMetrics.get(contractId);
  if (!m) return 0;
  const total = m.buckets.reduce((s, b) => s + b.total, 0);
  const failed = m.buckets.reduce((s, b) => s + b.failed, 0);
  return total === 0 ? 0 : failed / total;
}

function getRule(contractId) {
  if (alertRules.has(contractId)) return alertRules.get(contractId);
  return alertRules.get("*") || null;
}

function addAlertRule(rule) {
  const contractId = rule.contractId || "*";
  alertRules.set(contractId, {
    enabled: rule.enabled !== false,
    errorRateThreshold: Number.isFinite(rule.errorRateThreshold) ? rule.errorRateThreshold : DEFAULT_ERROR_RATE_THRESHOLD,
    minTotal: Number.isFinite(rule.minTotal) ? rule.minTotal : DEFAULT_MIN_TOTAL,
    webhookUrl: rule.webhookUrl,
    email: rule.email,
    dedupeWindowMs: Number.isFinite(rule.dedupeWindowMs) ? rule.dedupeWindowMs : DEFAULT_DEDUPE_WINDOW_MS,
    maxLatencyMs: Number.isFinite(rule.maxLatencyMs) ? rule.maxLatencyMs : DEFAULT_MAX_LATENCY_MS,
    anomalyZScore: Number.isFinite(rule.anomalyZScore) ? rule.anomalyZScore : DEFAULT_ANOMALY_ZSCORE,
  });
}

export function configureAlertRules(rules) {
  alertRules.clear();
  if (Array.isArray(rules)) {
    for (const rule of rules) addAlertRule(rule);
  } else if (rules) {
    addAlertRule(rules);
  }
}

function shouldSendAlert(contractId, type, dedupeWindowMs) {
  const now = Date.now();
  const state = alertState.get(contractId) || {};
  const last = state[type] || 0;
  if (now - last < dedupeWindowMs) return false;
  state[type] = now;
  alertState.set(contractId, state);
  return true;
}

function postToWebhook(url, payload) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const body = JSON.stringify(payload);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = lib.request(options, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`Webhook responded ${res.statusCode}`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function triggerAlert(payload) {
  const { contractId, type, rule } = payload;
  alertsTriggered.inc({ contractId, type });
  const message = `[${payload.severity || "WARNING"}.toUpperCase()] Distribution alert for contract ${contractId}: ${payload.condition}. Current value: ${payload.currentValue || "N/A"}. Threshold: ${payload.threshold || "N/A"}. Error count: ${payload.errorCount || "N/A"}. Total count: ${payload.totalCount || "N/A"}. Remedy: ${payload.remedy}`;
  if (rule && rule.webhookUrl) {
    try {
      await postToWebhook(rule.webhookUrl, { ...payload, message });
    } catch (e) {
      console.error("Failed to send webhook alert", e);
    }
  }
  if (rule && rule.email) {
    console.error(`[ALERT EMAIL] To: ${rule.email} - ${message}`);
  }
}

function detectAnomalies(m, rule, { token, amount, latencyMs }) {
  const anomalies = [];
  if (Number.isFinite(amount) && m.amounts.length >= 2) {
    const values = m.amounts;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const sd = Math.sqrt(variance);
    const zScore = sd > 0 ? Math.abs(amount - mean) / sd : 0;
    if (zScore > rule.anomalyZScore) {
      anomalies.push({ type: "large_distribution", amount, mean, zScore });
    }
  }
  if (token && m.tokens.size > 0 && !m.tokens.has(token)) {
    anomalies.push({ type: "unusual_token", token });
  }
  if (Number.isFinite(latencyMs) && latencyMs > rule.maxLatencyMs) {
    anomalies.push({ type: "high_latency", latencyMs, max: rule.maxLatencyMs });
  }
  return anomalies;
}

function recordDistributionOutcome({ contractId, success = true, token = null, amount = null, latencyMs = null }) {
  if (!contractId) return;
  const m = getContractMetrics(contractId);
  const rule = getRule(contractId);
  const anomalies = rule && rule.enabled ? detectAnomalies(m, rule, { token, amount, latencyMs }) : [];
  updateContractMetrics(contractId, success, { token, amount, latencyMs });
  if (rule && rule.enabled) {
    for (const anomaly of anomalies) {
      if (shouldSendAlert(contractId, anomaly.type, rule.dedupeWindowMs)) {
        triggerAlert({
          contractId,
          type: anomaly.type,
          severity: "warning",
          condition: `${anomaly.type} detected`,
          currentValue: anomaly.amount || anomaly.latencyMs || anomaly.token,
          threshold: anomaly.zScore ? rule.anomalyZScore : anomaly.max ? rule.maxLatencyMs : null,
          errorCount: null,
          totalCount: null,
          remedy: "Review the distribution payload and verify token/amount are expected. Investigate latency if high.",
          rule,
        }).catch((e) => console.error("Failed to trigger anomaly alert", e));
      }
    }
  }
}

async function evaluateErrorRateAlerts() {
  for (const [contractId, m] of contractMetrics.entries()) {
    const rule = getRule(contractId);
    if (!rule || !rule.enabled) continue;
    const total = m.buckets.reduce((s, b) => s + b.total, 0);
    const failed = m.buckets.reduce((s, b) => s + b.failed, 0);
    const errorRate = total === 0 ? 0 : failed / total;
    if (total >= rule.minTotal && errorRate > rule.errorRateThreshold) {
      const dedupeMs = rule.dedupeWindowMs;
      if (shouldSendAlert(contractId, "error_rate", dedupeMs)) {
        await triggerAlert({
          contractId,
          type: "error_rate",
          severity: errorRate > 0.25 ? "critical" : "warning",
          condition: `error_rate > ${(rule.errorRateThreshold * 100).toFixed(0)}%`,
          threshold: rule.errorRateThreshold,
          currentValue: errorRate,
          errorCount: failed,
          totalCount: total,
          remedy: "Check Horizon/Soroban RPC availability, verify contract balance, review recent deployments, and inspect logs.",
          rule,
        });
      }
    }
  }
}

export async function evaluateAlerts() {
  await evaluateErrorRateAlerts();
}

export function startAlertMonitor(intervalMs = 60000) {
  if (alertTimer) clearInterval(alertTimer);
  alertTimer = setInterval(() => {
    evaluateAlerts().catch((e) => console.error("Alert monitor error", e));
  }, intervalMs);
  if (alertTimer.unref) alertTimer.unref();
}

export function stopAlertMonitor() {
  if (alertTimer) {
    clearInterval(alertTimer);
    alertTimer = null;
  }
}

export function recordDistributeCall() {
  metrics.distributeCallsTotal += 1;
}

export function recordTransactionSuccess(contractId, meta = {}) {
  metrics.transactionsSuccessfulTotal += 1;
  recordDistributionOutcome({ contractId: typeof contractId === "string" ? contractId : meta.contractId, success: true, token: meta.token, amount: meta.amount, latencyMs: meta.latencyMs });
}

export function recordTransactionFailure(contractId, meta = {}) {
  metrics.transactionsFailedTotal += 1;
  recordDistributionOutcome({ contractId: typeof contractId === "string" ? contractId : meta.contractId, success: false, token: meta.token, amount: meta.amount, latencyMs: meta.latencyMs });
}

// DoS protection metrics (#426)
export function recordOversizedRequest() {
  metrics.oversizedRequestsRejectedTotal += 1;
}

export function recordDoSRejection() {
  metrics.dosRateLimitedTotal += 1;
}

// Detailed health check metrics (#423)
export function recordDetailedHealthCheck({ databaseMs, horizonMs, sorobanMs, cacheMs }) {
  metrics.healthCheckTotal += 1;
  if (Number.isFinite(databaseMs) && databaseMs >= 0)
    metrics.healthCheckDatabaseResponseTimeMs = databaseMs;
  if (Number.isFinite(horizonMs) && horizonMs >= 0)
    metrics.healthCheckHorizonResponseTimeMs = horizonMs;
  if (Number.isFinite(sorobanMs) && sorobanMs >= 0)
    metrics.healthCheckSorobanResponseTimeMs = sorobanMs;
  if (Number.isFinite(cacheMs) && cacheMs >= 0)
    metrics.healthCheckCacheResponseTimeMs = cacheMs;
}

export function recordHorizonResponseTime(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  metrics.horizonResponseTimeMsTotal += durationMs;
  metrics.horizonResponseTimeCount += 1;
}

/**
 * Record an RPC retry outcome from the centralized retry strategy
 * (see rpc-retry.js). `outcome` is one of:
 *   - "attempt":   a retry attempt is about to be executed
 *   - "success":   the operation succeeded after at least one retry
 *   - "exhausted": the operation failed after exhausting all retries
 *
 * Retry count and success rate are observable at /api/metrics as
 * `stellar_rpc_retries_total`, `stellar_rpc_retry_successes_total`,
 * `stellar_rpc_retry_exhausted_total` (labeled by operationType).
 */
export function recordRpcRetry(operationType, outcome) {
  const label = { operationType: typeof operationType === "string" && operationType ? operationType : "unknown" };
  if (outcome === "attempt") {
    metrics.rpcRetryAttempts += 1;
    rpcRetryAttempts.inc(label);
  } else if (outcome === "success") {
    metrics.rpcRetrySuccesses += 1;
    rpcRetrySuccesses.inc(label);
  } else if (outcome === "exhausted") {
    metrics.rpcRetryExhausted += 1;
    rpcRetryExhausted.inc(label);
  }
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

/**
 * Serialize all metrics (prom-client registry + legacy counters) to the
 * Prometheus text format.
 *
 * Async because prom-client's `register.metrics()` returns a Promise — an
 * earlier revision concatenated that Promise directly, silently shipping
 * "[object Promise]" instead of the registry metrics to /api/metrics and the
 * pushgateway.
 */
export async function prometheusMetrics() {
  const snapshot = getMetricsSnapshot();
  const legacyMetrics = [
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
    // RPC retry tracking (transient-failure retry strategy)
    "# HELP stellar_rpc_retry_attempts_total Total RPC retry attempts executed after a transient failure.",
    "# TYPE stellar_rpc_retry_attempts_total counter",
    `stellar_rpc_retry_attempts_total ${snapshot.rpcRetryAttempts}`,
    "# HELP stellar_rpc_retry_successes_total Total RPC operations that succeeded after at least one retry.",
    "# TYPE stellar_rpc_retry_successes_total counter",
    `stellar_rpc_retry_successes_total ${snapshot.rpcRetrySuccesses}`,
    "# HELP stellar_rpc_retry_exhausted_total Total RPC operations that failed after exhausting all retries.",
    "# TYPE stellar_rpc_retry_exhausted_total counter",
    `stellar_rpc_retry_exhausted_total ${snapshot.rpcRetryExhausted}`,
    "# HELP stellar_oversized_requests_rejected_total Requests rejected due to body size exceeding the limit.",
    "# TYPE stellar_oversized_requests_rejected_total counter",
    `stellar_oversized_requests_rejected_total ${snapshot.oversizedRequestsRejectedTotal}`,
    "# HELP stellar_dos_rate_limited_total Requests rate-limited due to repeated oversized payload attacks.",
    "# TYPE stellar_dos_rate_limited_total counter",
    `stellar_dos_rate_limited_total ${snapshot.dosRateLimitedTotal}`,
    "# HELP stellar_health_check_total Total detailed health check requests.",
    "# TYPE stellar_health_check_total counter",
    `stellar_health_check_total ${snapshot.healthCheckTotal}`,
    "# HELP stellar_health_database_response_time_ms Last database health check response time in milliseconds.",
    "# TYPE stellar_health_database_response_time_ms gauge",
    `stellar_health_database_response_time_ms ${formatMetricValue(snapshot.healthCheckDatabaseResponseTimeMs)}`,
    "# HELP stellar_health_horizon_response_time_ms Last Horizon health check response time in milliseconds.",
    "# TYPE stellar_health_horizon_response_time_ms gauge",
    `stellar_health_horizon_response_time_ms ${formatMetricValue(snapshot.healthCheckHorizonResponseTimeMs)}`,
    "# HELP stellar_health_soroban_response_time_ms Last Soroban RPC health check response time in milliseconds.",
    "# TYPE stellar_health_soroban_response_time_ms gauge",
    `stellar_health_soroban_response_time_ms ${formatMetricValue(snapshot.healthCheckSorobanResponseTimeMs)}`,
    "# HELP stellar_health_cache_response_time_ms Last cache health check response time in milliseconds.",
    "# TYPE stellar_health_cache_response_time_ms gauge",
    `stellar_health_cache_response_time_ms ${formatMetricValue(snapshot.healthCheckCacheResponseTimeMs)}`,
    // Connection health monitoring (#496)
    "# HELP stellar_db_health_checks_total Total connection health checks performed.",
    "# TYPE stellar_db_health_checks_total counter",
    `stellar_db_health_checks_total ${snapshot.connectionHealthTotalChecks}`,
    "# HELP stellar_db_health_failures_total Total connection health check failures.",
    "# TYPE stellar_db_health_failures_total counter",
    `stellar_db_health_failures_total ${snapshot.connectionHealthTotalFailures}`,
    "# HELP stellar_db_health_consecutive_failures Current consecutive connection failures.",
    "# TYPE stellar_db_health_consecutive_failures gauge",
    `stellar_db_health_consecutive_failures ${snapshot.connectionHealthConsecutiveFailures}`,
    "# HELP stellar_db_health_check_duration_ms Last connection health check duration in ms.",
    "# TYPE stellar_db_health_check_duration_ms gauge",
    `stellar_db_health_check_duration_ms ${formatMetricValue(snapshot.connectionHealthLastCheckDurationMs)}`,
    "# HELP stellar_db_reconnection_attempts_total Total reconnection attempts.",
    "# TYPE stellar_db_reconnection_attempts_total counter",
    `stellar_db_reconnection_attempts_total ${snapshot.connectionHealthReconnectionsAttempted}`,
    "# HELP stellar_db_reconnection_successes_total Total successful reconnections.",
    "# TYPE stellar_db_reconnection_successes_total counter",
    `stellar_db_reconnection_successes_total ${snapshot.connectionHealthReconnectionsSucceeded}`,
    "# HELP stellar_db_reconnection_failures_total Total failed reconnection attempts.",
    "# TYPE stellar_db_reconnection_failures_total counter",
    `stellar_db_reconnection_failures_total ${snapshot.connectionHealthReconnectionsFailed}`,
    "# HELP stellar_db_pool_utilization_percent Current database pool utilization percentage.",
    "# TYPE stellar_db_pool_utilization_percent gauge",
    `stellar_db_pool_utilization_percent ${formatMetricValue(snapshot.connectionHealthPoolUtilization)}`,
    "",
  ].join("\n");

  const registryText = await register.metrics();
  return registryText + "\n" + legacyMetrics;
}

export function recordConnectionHealthCheck(m) {
  metrics.connectionHealthTotalChecks = m.totalChecks ?? 0;
  metrics.connectionHealthTotalFailures = m.totalFailures ?? 0;
  metrics.connectionHealthConsecutiveFailures = m.consecutiveFailures ?? 0;
  metrics.connectionHealthLastCheckDurationMs = m.lastCheckDurationMs ?? 0;
  metrics.connectionHealthReconnectionsAttempted = m.reconnectionsAttempted ?? 0;
  metrics.connectionHealthReconnectionsSucceeded = m.reconnectionsSucceeded ?? 0;
  metrics.connectionHealthReconnectionsFailed = m.reconnectionsFailed ?? 0;
  metrics.connectionHealthPoolUtilization = m.poolUtilization ?? 0;
}

export function resetMetrics() {
  metrics.distributeCallsTotal = 0;
  metrics.transactionsSuccessfulTotal = 0;
  metrics.transactionsFailedTotal = 0;
  metrics.horizonResponseTimeMsTotal = 0;
  metrics.horizonResponseTimeCount = 0;
  metrics.oversizedRequestsRejectedTotal = 0;
  metrics.dosRateLimitedTotal = 0;
  metrics.rpcRetryAttempts = 0;
  metrics.rpcRetrySuccesses = 0;
  metrics.rpcRetryExhausted = 0;
  metrics.healthCheckDatabaseResponseTimeMs = 0;
  metrics.healthCheckHorizonResponseTimeMs = 0;
  metrics.healthCheckSorobanResponseTimeMs = 0;
  metrics.healthCheckCacheResponseTimeMs = 0;
  metrics.healthCheckTotal = 0;
  contractMetrics.clear();
  alertState.clear();
  register.resetMetrics();
}

// New comprehensive metrics functions (#816)
export function recordHttpRequest(method, route, status, durationMs) {
  const labels = { method, route: route || "unknown", status: String(status) };
  httpRequests.inc(labels);
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    httpRequestDuration.observe(labels, durationMs / 1000);
  }
}

export function recordContractFunctionDuration(contractId, functionName, durationSeconds) {
  contractFunctionDuration.observe({ contractId, functionName }, durationSeconds);
}

export function recordRpcOperationDuration(operationType, durationSeconds) {
  rpcOperationDuration.observe({ operationType }, durationSeconds);
}

export function recordDbQueryDuration(queryType, durationSeconds) {
  dbQueryDuration.observe({ queryType }, durationSeconds);
}

export function recordCacheHit(namespace) {
  cacheHits.inc({ namespace });
}

export function recordCacheMiss(namespace) {
  cacheMisses.inc({ namespace });
}

export function recordRateLimitHit(dimension) {
  rateLimitHits.inc({ dimension });
}

export function setActiveConnections(count) {
  activeConnections.set(count);
}
