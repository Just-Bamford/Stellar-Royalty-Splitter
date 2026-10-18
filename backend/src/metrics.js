import client from "prom-client";
import http from "http";
import https from "https";
import logger from "./logger.js";

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
  // Traffic shaping & capacity planning (#rate-limiting)
  trafficShapedTotal: 0,
  trafficShapingQueuedTotal: 0,
  trafficShapingRejectedTotal: 0,
  trafficShapingDegradedTotal: 0,
  capacityPeakLoadPercent: 0,
  capacityAlertsTotal: 0,
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

// ── Traffic shaping & capacity planning metrics ────────────────────────────

const trafficShaped = new client.Counter({
  name: "stellar_traffic_shaped_total",
  help: "Requests evaluated by the traffic shaper, by endpoint priority",
  labelNames: ["priority", "endpoint"],
  registers: [register],
});

const trafficShapingQueued = new client.Counter({
  name: "stellar_traffic_shaping_queued_total",
  help: "Requests queued for backpressure handling",
  labelNames: ["priority"],
  registers: [register],
});

const trafficShapingRejected = new client.Counter({
  name: "stellar_traffic_shaping_rejected_total",
  help: "Requests rejected with 429 due to traffic shaping",
  labelNames: ["priority", "endpoint"],
  registers: [register],
});

const trafficShapingDegraded = new client.Counter({
  name: "stellar_traffic_shaping_degraded_total",
  help: "Requests served with degraded (cached) responses under load",
  labelNames: ["endpoint"],
  registers: [register],
});

const trafficShapingQueueDepth = new client.Gauge({
  name: "stellar_traffic_shaping_queue_depth",
  help: "Current number of requests waiting in the backpressure queue",
  labelNames: ["priority"],
  registers: [register],
});

const capacityLoadPercent = new client.Gauge({
  name: "stellar_capacity_load_percent",
  help: "Current estimated system load as a percentage of capacity",
  registers: [register],
});

const capacityPeakLoadPercent = new client.Gauge({
  name: "stellar_capacity_peak_load_percent",
  help: "Observed peak system load as a percentage of capacity",
  registers: [register],
});

const capacityAlerts = new client.Counter({
  name: "stellar_capacity_alerts_total",
  help: "Capacity alerts triggered when load exceeded the configured threshold",
  labelNames: ["severity"],
  registers: [register],
});

const capacityScaleRecommendations = new client.Counter({
  name: "stellar_capacity_scale_recommendations_total",
  help: "Scale recommendations emitted by the capacity planner",
  labelNames: ["direction"],
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

// ── Distribution & royalty metrics for the Grafana dashboards (#935) ────────

// Latency per distribution phase. "simulation" is the Soroban dry run behind
// /simulate, "build" is recording + preparing the unsigned XDR, and
// "submission" is wall-clock time from the transaction being recorded to its
// on-chain confirmation (observed by /transaction/confirm).
const distributionLatency = new client.Histogram({
  name: "stellar_distribution_latency_seconds",
  help: "Distribution latency by phase (simulation, build, submission)",
  labelNames: ["phase"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

// Soroban resource fee reported by simulation — the network's "gas" for a
// distribute call, in stroops.
const distributionGas = new client.Histogram({
  name: "stellar_distribution_gas_stroops",
  help: "Simulated resource fee (stroops) per distribution",
  buckets: [100, 1000, 10000, 50000, 100000, 250000, 500000, 1000000, 5000000, 10000000],
  registers: [register],
});

const distributionsTotal = new client.Counter({
  name: "stellar_distributions_total",
  help: "Distributions by outcome (built, confirmed, failed)",
  labelNames: ["outcome"],
  registers: [register],
});

const secondarySaleProcessing = new client.Histogram({
  name: "stellar_secondary_sale_processing_seconds",
  help: "Time to process a secondary sale (rate lookup, persistence, XDR build)",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

const secondaryRoyaltyAccrued = new client.Counter({
  name: "stellar_secondary_royalty_accrued_total",
  help: "Secondary-sale royalties accrued into the pool (stroops)",
  labelNames: ["contractId"],
  registers: [register],
});

const secondaryRoyaltyDistributed = new client.Counter({
  name: "stellar_secondary_royalty_distributed_total",
  help: "Secondary royalties distributed out of the pool (stroops)",
  labelNames: ["contractId"],
  registers: [register],
});

// The pool balance is read from the database at scrape time rather than
// derived from the counters above, so it stays correct across restarts.
let secondaryRoyaltyPoolSource = null;
new client.Gauge({
  name: "stellar_secondary_royalty_pool_pending",
  help: "Undistributed secondary royalties currently in the pool (stroops)",
  labelNames: ["contractId"],
  registers: [register],
  collect() {
    this.reset();
    if (!secondaryRoyaltyPoolSource) return;
    try {
      for (const { contractId, pending } of secondaryRoyaltyPoolSource()) {
        const value = Number(pending);
        if (contractId && Number.isFinite(value)) this.set({ contractId }, value);
      }
    } catch {
      // A failed DB read must never break the whole /metrics scrape.
    }
  },
});

// Collaborator addresses are unbounded, so the label set is capped; payouts to
// collaborators beyond the cap are aggregated under "other".
const MAX_COLLABORATOR_SERIES = parseInt(process.env.METRICS_MAX_COLLABORATOR_SERIES ?? "500", 10);
const trackedCollaborators = new Set();

const collaboratorEarnings = new client.Counter({
  name: "stellar_collaborator_earnings_total",
  help: "Amount paid out to collaborators (stroops)",
  labelNames: ["contractId", "collaborator"],
  registers: [register],
});

const collaboratorPayouts = new client.Counter({
  name: "stellar_collaborator_payouts_total",
  help: "Number of payouts made to collaborators",
  labelNames: ["contractId", "collaborator"],
  registers: [register],
});

const contractStateChanges = new client.Counter({
  name: "stellar_contract_state_changes_total",
  help: "Contract state changes recorded in the audit trail, by action",
  labelNames: ["contractId", "action"],
  registers: [register],
});

// ── Immutable audit trail (#938) ───────────────────────────────────────────

const auditTrailIntegrity = new client.Gauge({
  name: "stellar_audit_trail_integrity_ok",
  help: "1 when the last audit-trail hash-chain verification passed, 0 when it failed",
  registers: [register],
});

const auditTrailVerifications = new client.Counter({
  name: "stellar_audit_trail_verifications_total",
  help: "Audit-trail integrity verifications by result",
  labelNames: ["result"],
  registers: [register],
});

const auditTrailLastVerified = new client.Gauge({
  name: "stellar_audit_trail_last_verified_timestamp_seconds",
  help: "Unix time of the last completed audit-trail verification",
  registers: [register],
});

const auditTrailEntries = new client.Gauge({
  name: "stellar_audit_trail_entries",
  help: "Entries currently held in the immutable audit trail",
  registers: [register],
});

const auditTrailWriteFailures = new client.Counter({
  name: "stellar_audit_trail_write_failures_total",
  help: "State changes that could not be appended to the immutable audit trail",
  registers: [register],
});

// Traffic shaping & capacity planning helpers
export function recordTrafficShaped(priority, endpoint) {
  metrics.trafficShapedTotal += 1;
  trafficShaped.inc({ priority: priority || "standard", endpoint: endpoint || "unknown" });
}

export function recordTrafficQueued(priority) {
  metrics.trafficShapingQueuedTotal += 1;
  trafficShapingQueued.inc({ priority: priority || "standard" });
}

export function recordTrafficRejected(priority, endpoint) {
  metrics.trafficShapingRejectedTotal += 1;
  trafficShapingRejected.inc({ priority: priority || "standard", endpoint: endpoint || "unknown" });
}

export function recordTrafficDegraded(endpoint) {
  metrics.trafficShapingDegradedTotal += 1;
  trafficShapingDegraded.inc({ endpoint: endpoint || "unknown" });
}

export function setTrafficQueueDepth(priority, depth) {
  trafficShapingQueueDepth.set({ priority: priority || "standard" }, Number(depth) || 0);
}

export function setCapacityLoad(percent) {
  const value = Number.isFinite(percent) ? percent : 0;
  metrics.capacityPeakLoadPercent = Math.max(metrics.capacityPeakLoadPercent, value);
  capacityLoadPercent.set(value);
  capacityPeakLoadPercent.set(metrics.capacityPeakLoadPercent);
}

export function recordCapacityAlert(severity) {
  metrics.capacityAlertsTotal += 1;
  capacityAlerts.inc({ severity: severity || "warning" });
}

export function recordScaleRecommendation(direction) {
  capacityScaleRecommendations.inc({ direction: direction || "none" });
}

// Alerting constants
const ALERT_WINDOW_MS = 5 * 60 * 1000;
const ALERT_HISTORY_MS = 60 * 60 * 1000;
const MAX_BUCKETS = Math.ceil(ALERT_HISTORY_MS / ALERT_WINDOW_MS);
const DEFAULT_ERROR_RATE_THRESHOLD = 0.10;
const DEFAULT_MIN_TOTAL = 10;
const DEFAULT_DEDUPE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX_LATENCY_MS = 5000;
const DEFAULT_ANOMALY_ZSCORE = 3.5;
const DEFAULT_P95_LATENCY_THRESHOLD_MS = 500;
const DEFAULT_ERROR_RATE_ALERT_THRESHOLD = 0.01;
const DEFAULT_CONTRACT_CALL_FAILURE_WINDOW_MS = 5 * 60 * 1000;

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

// ── Advanced performance monitoring & alerting ─────────────────────────────

// p95 latency per route, tracked in a rolling window so the alert evaluator
// can fire when p95 exceeds the configured threshold (default 500ms).
const routeLatencySamples = new Map();
const ROUTE_LATENCY_WINDOW_SIZE = 200;

// Contract call failure tracking for alerting on any failed contract call.
const contractCallFailures = new Map();

const p95LatencyAlerts = new client.Counter({
  name: "stellar_p95_latency_alerts_total",
  help: "Total alerts triggered because p95 latency exceeded the configured threshold",
  labelNames: ["route"],
  registers: [register],
});

const errorRateAlerts = new client.Counter({
  name: "stellar_error_rate_alerts_total",
  help: "Total alerts triggered because error rate exceeded the configured threshold",
  labelNames: ["route"],
  registers: [register],
});

const contractCallFailureAlerts = new client.Counter({
  name: "stellar_contract_call_failure_alerts_total",
  help: "Total alerts triggered because a contract call failed",
  labelNames: ["contractId", "functionName"],
  registers: [register],
});

const incidentCounter = new client.Counter({
  name: "stellar_incidents_total",
  help: "Total incidents tracked by severity",
  labelNames: ["severity", "type"],
  registers: [register],
});

const incidentMttrSeconds = new client.Histogram({
  name: "stellar_incident_mttr_seconds",
  help: "Mean time to recovery (seconds) for resolved incidents",
  labelNames: ["severity"],
  buckets: [30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 86400],
  registers: [register],
});

const openIncidents = new client.Gauge({
  name: "stellar_incidents_open",
  help: "Number of currently open incidents",
  registers: [register],
});

const incidents = new Map();
let incidentSequence = 0;

function getRouteLatencySamples(route) {
  if (!routeLatencySamples.has(route)) routeLatencySamples.set(route, []);
  return routeLatencySamples.get(route);
}

function getP95ThresholdMs() {
  const configured = Number(process.env.P95_LATENCY_THRESHOLD_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_P95_LATENCY_THRESHOLD_MS;
}

function getErrorRateThreshold() {
  const configured = Number(process.env.ERROR_RATE_THRESHOLD);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ERROR_RATE_ALERT_THRESHOLD;
}

function percentile(values, p) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Record a request latency sample for a route and evaluate the p95 latency
 * alert threshold (default 500ms). Emits a multi-channel alert when exceeded.
 */
export function recordRouteLatency(route, durationMs) {
  if (!route || !Number.isFinite(durationMs) || durationMs < 0) return;
  const samples = getRouteLatencySamples(route);
  samples.push(durationMs);
  if (samples.length > ROUTE_LATENCY_WINDOW_SIZE) samples.shift();

  const threshold = getP95ThresholdMs();
  const p95 = percentile(samples, 95);
  if (samples.length >= 5 && p95 > threshold) {
    if (shouldSendAlert(`route:${route}`, "p95_latency", DEFAULT_DEDUPE_WINDOW_MS)) {
      p95LatencyAlerts.inc({ route });
      alertsTriggered.inc({ contractId: route, type: "p95_latency" });
      triggerAlert({
        contractId: route,
        type: "p95_latency",
        severity: "critical",
        condition: `p95 latency > ${threshold}ms`,
        currentValue: Number(p95.toFixed(2)),
        threshold,
        remedy: "Inspect slow dependencies (DB, Horizon, Soroban RPC), check for N+1 queries, and scale the affected service.",
        rule: getRule(route) || {},
      }).catch((e) => logger.error("Failed to trigger p95 latency alert", e));
    }
  }
}

/**
 * Record a request outcome for error-rate alerting (default 1% threshold).
 */
export function recordRouteOutcome(route, success) {
  if (!route) return;
  const m = getContractMetrics(`route:${route}`);
  const now = Date.now();
  let bucket = m.buckets.length > 0 ? m.buckets[m.buckets.length - 1] : null;
  if (!bucket || now - bucket.start >= ALERT_WINDOW_MS) {
    bucket = { start: now, total: 0, failed: 0 };
    m.buckets.push(bucket);
    if (m.buckets.length > MAX_BUCKETS) m.buckets.shift();
  }
  bucket.total += 1;
  if (!success) bucket.failed += 1;

  const total = m.buckets.reduce((s, b) => s + b.total, 0);
  const failed = m.buckets.reduce((s, b) => s + b.failed, 0);
  const errorRate = total === 0 ? 0 : failed / total;
  const threshold = getErrorRateThreshold();
  if (total >= DEFAULT_MIN_TOTAL && errorRate > threshold) {
    if (shouldSendAlert(`route:${route}`, "error_rate", DEFAULT_DEDUPE_WINDOW_MS)) {
      errorRateAlerts.inc({ route });
      alertsTriggered.inc({ contractId: route, type: "error_rate" });
      triggerAlert({
        contractId: route,
        type: "error_rate",
        severity: errorRate > 0.05 ? "critical" : "warning",
        condition: `error rate > ${(threshold * 100).toFixed(2)}%`,
        currentValue: Number(errorRate.toFixed(4)),
        threshold,
        errorCount: failed,
        totalCount: total,
        remedy: "Check recent deployments, dependency health, and error logs for the affected route.",
        rule: getRule(route) || {},
      }).catch((e) => logger.error("Failed to trigger error rate alert", e));
    }
  }
}

/**
 * Record a contract call failure and immediately alert (any failure triggers).
 */
export function recordContractCallFailure(contractId, functionName, error) {
  const id = contractId || "unknown";
  const fn = functionName || "unknown";
  const key = `${id}:${fn}`;
  const entry = contractCallFailures.get(key) || { count: 0, lastAt: 0 };
  entry.count += 1;
  entry.lastAt = Date.now();
  contractCallFailures.set(key, entry);

  contractCallFailureAlerts.inc({ contractId: id, functionName: fn });
  alertsTriggered.inc({ contractId: id, type: "contract_call_failure" });

  if (shouldSendAlert(key, "contract_call_failure", DEFAULT_CONTRACT_CALL_FAILURE_WINDOW_MS)) {
    triggerAlert({
      contractId: id,
      type: "contract_call_failure",
      severity: "critical",
      condition: `contract call ${fn} failed`,
      currentValue: entry.count,
      threshold: 1,
      remedy: "Inspect the contract invocation, verify arguments and network status, and check Soroban RPC availability.",
      rule: getRule(id) || {},
    }).catch((e) => logger.error("Failed to trigger contract call failure alert", e));
  }
}

/**
 * Open a new incident for tracking. Returns the incident id.
 */
export function openIncident({ type, severity = "warning", summary, details = {} }) {
  incidentSequence += 1;
  const id = `INC-${Date.now()}-${incidentSequence}`;
  const incident = {
    id,
    type: type || "unknown",
    severity,
    summary: summary || "",
    details,
    status: "open",
    openedAt: Date.now(),
    resolvedAt: null,
    mttrSeconds: null,
    rootCause: null,
    postMortem: null,
  };
  incidents.set(id, incident);
  incidentCounter.inc({ severity, type: incident.type });
  openIncidents.set(incidents.size);
  return id;
}

/**
 * Resolve an incident and record MTTR.
 */
export function resolveIncident(id, { rootCause = null, postMortem = null } = {}) {
  const incident = incidents.get(id);
  if (!incident || incident.status === "resolved") return null;
  incident.status = "resolved";
  incident.resolvedAt = Date.now();
  incident.mttrSeconds = (incident.resolvedAt - incident.openedAt) / 1000;
  incident.rootCause = rootCause;
  incident.postMortem = postMortem;
  incidentMttrSeconds.observe({ severity: incident.severity }, incident.mttrSeconds);
  openIncidents.set([...incidents.values()].filter((i) => i.status === "open").length);
  return incident;
}

export function getIncident(id) {
  return incidents.get(id) || null;
}

export function listIncidents() {
  return [...incidents.values()];
}

export function getMttrStats() {
  const resolved = [...incidents.values()].filter((i) => i.status === "resolved" && Number.isFinite(i.mttrSeconds));
  if (resolved.length === 0) return { count: 0, avgMttrSeconds: 0, minMttrSeconds: 0, maxMttrSeconds: 0 };
  const values = resolved.map((i) => i.mttrSeconds);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    count: resolved.length,
    avgMttrSeconds: sum / resolved.length,
    minMttrSeconds: Math.min(...values),
    maxMttrSeconds: Math.max(...values),
  };
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
  if (rule && rule.slackWebhookUrl) {
    try {
      await postToWebhook(rule.slackWebhookUrl, { text: message, ...payload });
    } catch (e) {
      console.error("Failed to send Slack alert", e);
    }
  }
  if (rule && rule.smsNumber) {
    console.error(`[ALERT SMS] To: ${rule.smsNumber} - ${message}`);
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
  recordRouteOutcome("transaction", false);
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
    openIncidents: [...incidents.values()].filter((i) => i.status === "open").length,
    mttr: getMttrStats(),
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
    "# HELP stellar_incidents_open_total Number of currently open incidents.",
    "# TYPE stellar_incidents_open_total gauge",
    `stellar_incidents_open_total ${snapshot.openIncidents}`,
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
  trackedCollaborators.clear();
  routeLatencySamples.clear();
  contractCallFailures.clear();
  incidents.clear();
  incidentSequence = 0;
  resetEndpointMetrics();
  register.resetMetrics();
}

// ── #935 recorders ─────────────────────────────────────────────────────────

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** @param {"simulation"|"build"|"submission"} phase */
export function recordDistributionLatency(phase, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  distributionLatency.observe({ phase }, durationMs / 1000);
}

export function recordDistributionGas(feeStroops) {
  const fee = toFiniteNumber(feeStroops);
  if (fee === null || fee < 0) return;
  distributionGas.observe(fee);
}

/** @param {"built"|"confirmed"|"failed"} outcome */
export function recordDistributionOutcomeMetric(outcome) {
  distributionsTotal.inc({ outcome });
}

export function recordSecondarySaleProcessing(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  secondarySaleProcessing.observe(durationMs / 1000);
}

export function recordSecondaryRoyaltyAccrued(contractId, amount) {
  const value = toFiniteNumber(amount);
  if (!contractId || value === null || value <= 0) return;
  secondaryRoyaltyAccrued.inc({ contractId }, value);
}

export function recordSecondaryRoyaltyDistributed(contractId, amount) {
  const value = toFiniteNumber(amount);
  if (!contractId || value === null || value <= 0) return;
  secondaryRoyaltyDistributed.inc({ contractId }, value);
}

/**
 * Register the function the pool gauge reads at scrape time. It must return
 * an array of `{ contractId, pending }`.
 */
export function setSecondaryRoyaltyPoolSource(fn) {
  secondaryRoyaltyPoolSource = typeof fn === "function" ? fn : null;
}

export function recordCollaboratorPayout(contractId, collaborator, amount) {
  const value = toFiniteNumber(amount);
  if (!contractId || !collaborator || value === null || value < 0) return;
  let label = collaborator;
  if (!trackedCollaborators.has(collaborator)) {
    if (trackedCollaborators.size < MAX_COLLABORATOR_SERIES) {
      trackedCollaborators.add(collaborator);
    } else {
      label = "other";
    }
  }
  const labels = { contractId, collaborator: label };
  collaboratorPayouts.inc(labels);
  collaboratorEarnings.inc(labels, value);
}

export function recordContractStateChange(contractId, action) {
  if (!contractId || !action) return;
  contractStateChanges.inc({ contractId, action });
}

// New comprehensive metrics functions (#816)
export function recordHttpRequest(method, route, status, durationMs) {
  const labels = { method, route: route || "unknown", status: String(status) };
  httpRequests.inc(labels);
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    httpRequestDuration.observe(labels, durationMs / 1000);
    recordRouteLatency(route || "unknown", durationMs);
    recordRouteOutcome(route || "unknown", Number(status) < 500);
  }
}

export function recordContractFunctionDuration(contractId, functionName, durationSeconds) {
  contractFunctionDuration.observe({ contractId, functionName }, durationSeconds);
  recordRouteLatency(`contract:${contractId}:${functionName}`, durationSeconds * 1000);
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

// ── #938 recorders ─────────────────────────────────────────────────────────

export function recordAuditTrailVerification({ ok, entriesChecked }) {
  auditTrailIntegrity.set(ok ? 1 : 0);
  auditTrailVerifications.inc({ result: ok ? "pass" : "fail" });
  auditTrailLastVerified.set(Date.now() / 1000);
  if (Number.isFinite(entriesChecked)) auditTrailEntries.set(entriesChecked);
}

export function recordAuditTrailWriteFailure() {
  auditTrailWriteFailures.inc();
}

// ── #936 traffic shadowing ─────────────────────────────────────────────────

const shadowRequests = new client.Counter({
  name: "stellar_shadow_requests_total",
  help: "Requests mirrored to the canary, by whether its status class matched the primary response",
  labelNames: ["result"],
  registers: [register],
});

const shadowLatency = new client.Histogram({
  name: "stellar_shadow_request_duration_seconds",
  help: "Latency of mirrored requests against the canary",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

/** @param {"match"|"mismatch"|"error"} result */
export function recordShadowRequest(result, durationMs) {
  shadowRequests.inc({ result });
  if (Number.isFinite(durationMs) && durationMs >= 0) shadowLatency.observe(durationMs / 1000);
}

// ── #985 APM Endpoint Response Time & P95 Alerting ─────────────────────────

const DEFAULT_P95_THRESHOLD_MS = 100;
const APM_WINDOW_SIZE = 100;
const APM_MIN_SAMPLES_FOR_ALERT = 5;
const APM_ALERT_DEDUPE_MS = 60 * 1000;

const endpointLatencySamples = new Map();
const endpointAlertState = new Map();

const endpointP95Alerts = new client.Counter({
  name: "stellar_endpoint_p95_alerts_total",
  help: "Total P95 latency threshold (100ms) violation alerts triggered per endpoint",
  labelNames: ["method", "route"],
  registers: [register],
});

const endpointP95Latency = new client.Gauge({
  name: "stellar_endpoint_p95_latency_ms",
  help: "Observed P95 response time per endpoint in milliseconds",
  labelNames: ["method", "route"],
  registers: [register],
});

/**
 * Calculates percentile from an array of numbers.
 * @param {number[]} values
 * @param {number} p - Percentile between 0 and 100
 * @returns {number}
 */
export function calculatePercentile(values, p) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  if (upper >= sorted.length) return sorted[sorted.length - 1];
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Record an endpoint response time sample for APM metrics and check P95 alerting.
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} route - Normalized route pattern
 * @param {number|string} status - HTTP status code
 * @param {number} durationMs - Duration in milliseconds
 */
export function recordEndpointResponseTime(method, route, status, durationMs) {
  const normMethod = (method || "GET").toUpperCase();
  const normRoute = route || "unmatched";

  // Record to standard Prometheus HTTP counters and duration histograms
  recordHttpRequest(normMethod, normRoute, status, durationMs);

  if (!Number.isFinite(durationMs) || durationMs < 0) return;

  const key = `${normMethod}:${normRoute}`;
  let samples = endpointLatencySamples.get(key);
  if (!samples) {
    samples = [];
    endpointLatencySamples.set(key, samples);
  }

  samples.push(durationMs);
  if (samples.length > APM_WINDOW_SIZE) {
    samples.shift();
  }

  const p95 = calculatePercentile(samples, 95);
  endpointP95Latency.set({ method: normMethod, route: normRoute }, Number(p95.toFixed(2)));

  // Evaluate P95 threshold violation alert
  const threshold = Number(process.env.APM_P95_ALERT_THRESHOLD_MS) || DEFAULT_P95_THRESHOLD_MS;
  if (samples.length >= APM_MIN_SAMPLES_FOR_ALERT && p95 > threshold) {
    const now = Date.now();
    const lastAlert = endpointAlertState.get(key) || 0;
    if (now - lastAlert >= APM_ALERT_DEDUPE_MS) {
      endpointAlertState.set(key, now);
      endpointP95Alerts.inc({ method: normMethod, route: normRoute });
      alertsTriggered.inc({ contractId: normRoute, type: "endpoint_p95_latency" });

      logger.error(
        `[CRITICAL] P95 response time alert: endpoint ${normMethod} ${normRoute} P95 latency ${p95.toFixed(2)}ms exceeds ${threshold}ms threshold`,
        {
          method: normMethod,
          route: normRoute,
          p95Ms: Number(p95.toFixed(2)),
          thresholdMs: threshold,
          sampleCount: samples.length,
        }
      );
    }
  }
}

/**
 * Get APM metrics for a specific endpoint.
 * @param {string} method
 * @param {string} route
 * @returns {object|null}
 */
export function getEndpointMetrics(method, route) {
  const normMethod = (method || "GET").toUpperCase();
  const normRoute = route || "unmatched";
  const key = `${normMethod}:${normRoute}`;
  const samples = endpointLatencySamples.get(key);
  if (!samples || samples.length === 0) return null;

  const count = samples.length;
  const sum = samples.reduce((acc, v) => acc + v, 0);
  const avg = sum / count;
  const p50 = calculatePercentile(samples, 50);
  const p95 = calculatePercentile(samples, 95);
  const p99 = calculatePercentile(samples, 99);
  const min = Math.min(...samples);
  const max = Math.max(...samples);

  return {
    method: normMethod,
    route: normRoute,
    count,
    avg: Number(avg.toFixed(2)),
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    p50: Number(p50.toFixed(2)),
    p95: Number(p95.toFixed(2)),
    p99: Number(p99.toFixed(2)),
  };
}

/**
 * Get APM metrics for all tracked endpoints.
 * @returns {Array<object>}
 */
export function getAllEndpointMetrics() {
  const results = [];
  for (const key of endpointLatencySamples.keys()) {
    const colonIdx = key.indexOf(":");
    const method = key.slice(0, colonIdx);
    const route = key.slice(colonIdx + 1);
    const m = getEndpointMetrics(method, route);
    if (m) results.push(m);
  }
  return results;
}

/**
 * Reset APM endpoint metrics.
 */
export function resetEndpointMetrics() {
  endpointLatencySamples.clear();
  endpointAlertState.clear();
  endpointP95Latency.reset();
  endpointP95Alerts.reset();
}
