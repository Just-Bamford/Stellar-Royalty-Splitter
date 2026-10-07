/**
 * Advanced Feature Flags and Gradual Rollout Service (#1075)
 *
 * Runtime feature flags with:
 *   - per-flag enable/disable (no redeploy needed)
 *   - targeting rules: enable/disable for specific users, orgs, or roles
 *   - deterministic percentage-based gradual rollout
 *   - error/latency metrics and health monitoring
 *   - instant, safe rollback (kill switch)
 *   - a full audit history of every change
 *
 * The flag store is provided by database/feature-flags.js; this module owns
 * validation, evaluation, and rollout/business logic.
 */

import crypto from "crypto";
import {
  createFlagRecord,
  getFlagRecord,
  listFlagRecords,
  updateFlagRecord,
  addFlagRuleRecord,
  getFlagRuleRecord,
  listFlagRules,
  deleteFlagRuleRecord,
  addFlagHistoryRecord,
  getFlagHistoryRecords,
  addFlagMetricRecord,
  getFlagMetricRecords,
} from "../database/feature-flags.js";
import logger from "../logger.js";

export const RULE_TYPES = ["user", "org", "role"];
export const FLAG_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
export const METRIC_TYPES = ["request", "error", "latency"];

// Default thresholds used when monitoring a rollout. Overridable per call or
// through FEATURE_FLAG_MAX_ERROR_RATE / FEATURE_FLAG_MAX_P95_LATENCY_MS.
export const DEFAULT_MAX_ERROR_RATE = 0.05; // 5% of requests may error
export const DEFAULT_MAX_P95_LATENCY_MS = 1000;

// Short-lived cache so resolving flags on every request does not hammer the
// database. Writes invalidate it immediately.
const CACHE_TTL_MS = Number(process.env.FEATURE_FLAG_CACHE_TTL_MS ?? 5000);
let _flagsCache = null;
let _flagsCacheAt = 0;

function invalidateCache() {
  _flagsCache = null;
  _flagsCacheAt = 0;
}

/** Flush the in-process flag cache (used after out-of-band changes and in tests). */
export function invalidateFlagCache() {
  invalidateCache();
}

function loadEnabledFlags() {
  const now = Date.now();
  if (_flagsCache && now - _flagsCacheAt < CACHE_TTL_MS) return _flagsCache;
  _flagsCache = listFlagRecords({ includeArchived: false });
  _flagsCacheAt = now;
  return _flagsCache;
}

/**
 * Validate a flag name.
 */
export function isValidFlagName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 100 && FLAG_NAME_PATTERN.test(name);
}

/**
 * Deterministic bucket in [0, 100) for a stable identifier. Hashing the flag
 * name together with the identifier keeps a user's bucket stable per flag and
 * independent across flags.
 */
export function stableBucket(flagName, identifier) {
  const digest = crypto.createHash("sha256").update(`${flagName}:${identifier ?? "anonymous"}`).digest();
  // First 4 bytes as an unsigned integer, modulo 100.
  return digest.readUInt32BE(0) % 100;
}

/**
 * Build a stable identifier from an evaluation context.
 * Preference order: explicit userId, wallet address, org, role, anonymous.
 */
export function stableIdentifier(context = {}) {
  return (
    context.userId ||
    context.walletAddress ||
    context.orgId ||
    context.role ||
    context.sessionId ||
    "anonymous"
  );
}

/**
 * Evaluate a single flag against a context. Rules take precedence over the
 * global enabled flag and the rollout percentage, which is what makes
 * "enable for specific users/orgs" possible even while the flag is otherwise
 * off. A killed flag is always off, no matter what rules apply.
 */
export function evaluateFlagRecord(flag, context = {}, rules = null) {
  if (!flag || flag.archived) return false;
  if (flag.killed) return false;

  const flagRules = rules ?? listFlagRules(flag.id);

  // Most specific match wins: user > org > role.
  for (const ruleType of ["user", "org", "role"]) {
    const expected = contextValueForRuleType(context, ruleType);
    if (!expected) continue;
    const match = flagRules.find(
      (r) => r.ruleType === ruleType && String(r.value) === String(expected),
    );
    if (match) return Boolean(match.enabled);
  }

  if (!flag.enabled) return false;

  const percentage = Number(flag.rolloutPercentage ?? 0);
  if (percentage >= 100) return true;
  if (percentage <= 0) return false;

  const identifier = stableIdentifier(context);
  // Anonymous callers cannot be bucketed stably, so they only get access once
  // the rollout is complete.
  if (identifier === "anonymous") return false;

  return stableBucket(flag.name, identifier) < percentage;
}

function contextValueForRuleType(context, ruleType) {
  if (ruleType === "user") return context.userId || context.walletAddress;
  if (ruleType === "org") return context.orgId;
  if (ruleType === "role") return context.role;
  return null;
}

/**
 * Check whether a named flag is enabled for a context.
 */
export function isEnabled(name, context = {}) {
  const flag = getFlagRecord(name);
  if (!flag) return false;
  return evaluateFlagRecord(flag, context);
}

/**
 * Evaluate many flags at once, returning a { name: boolean } map.
 * When `names` is omitted every non-archived flag is evaluated.
 */
export function evaluateAll(context = {}, names = null) {
  const flags = loadEnabledFlags();
  const selected = names ? flags.filter((f) => names.includes(f.name)) : flags;
  const result = {};
  for (const flag of selected) {
    result[flag.name] = evaluateFlagRecord(flag, context);
  }
  return result;
}

// ── Flag CRUD ─────────────────────────────────────────────────────────────────

export function createFlag({
  name,
  description = null,
  enabled = false,
  rolloutPercentage = 100,
  createdBy = "system",
}) {
  if (!isValidFlagName(name)) {
    throw new Error(
      "Invalid flag name. Use letters, numbers, dots, dashes or underscores (max 100 chars).",
    );
  }
  if (typeof rolloutPercentage !== "number" || rolloutPercentage < 0 || rolloutPercentage > 100) {
    throw new Error("rolloutPercentage must be a number between 0 and 100");
  }

  const existing = getFlagRecord(name);
  if (existing) throw new Error(`Feature flag '${name}' already exists`);

  const flag = createFlagRecord({ name, description, enabled, rolloutPercentage, createdBy });
  if (!flag) throw new Error(`Feature flag '${name}' already exists`);

  addFlagHistoryRecord({
    flagId: flag.id,
    flagName: flag.name,
    action: "create",
    changedBy: createdBy,
    newValue: flag,
    reason: "Flag created",
  });
  invalidateCache();
  logger.info("Feature flag created", { name, enabled, rolloutPercentage, createdBy });
  return flag;
}

/**
 * Get a flag with its targeting rules.
 */
export function getFlag(name) {
  const flag = getFlagRecord(name);
  if (!flag) return null;
  return { ...flag, rules: listFlagRules(flag.id) };
}

export function listFlags({ includeArchived = false } = {}) {
  return listFlagRecords({ includeArchived }).map((flag) => ({
    ...flag,
    rules: listFlagRules(flag.id),
  }));
}

/**
 * Update mutable flag fields (description, enabled, rolloutPercentage).
 */
export function updateFlag(name, updates = {}, changedBy = "system", reason = "Flag updated") {
  const existing = getFlagRecord(name);
  if (!existing) throw new Error(`Feature flag '${name}' not found`);

  if (
    updates.rolloutPercentage !== undefined &&
    (typeof updates.rolloutPercentage !== "number" ||
      updates.rolloutPercentage < 0 ||
      updates.rolloutPercentage > 100)
  ) {
    throw new Error("rolloutPercentage must be a number between 0 and 100");
  }

  const patch = {};
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.enabled !== undefined) patch.enabled = Boolean(updates.enabled);
  if (updates.rolloutPercentage !== undefined) patch.rolloutPercentage = updates.rolloutPercentage;

  const updated = updateFlagRecord(existing.id, patch);
  addFlagHistoryRecord({
    flagId: existing.id,
    flagName: existing.name,
    action: "update",
    changedBy,
    oldValue: existing,
    newValue: updated,
    reason,
  });
  invalidateCache();
  logger.info("Feature flag updated", { name, changes: patch, changedBy });
  return updated;
}

/**
 * Archive a flag. Archived flags are ignored during evaluation and hidden from
 * the default list; history is preserved.
 */
export function deleteFlag(name, changedBy = "system", reason = "Flag archived") {
  const existing = getFlagRecord(name);
  if (!existing) throw new Error(`Feature flag '${name}' not found`);

  const updated = updateFlagRecord(existing.id, { archived: true, enabled: false, killed: true });
  addFlagHistoryRecord({
    flagId: existing.id,
    flagName: existing.name,
    action: "archive",
    changedBy,
    oldValue: existing,
    newValue: updated,
    reason,
  });
  invalidateCache();
  return updated;
}

// ── Targeting rules ───────────────────────────────────────────────────────────

export function addRule(name, { ruleType, value, enabled = true }, changedBy = "system") {
  const flag = getFlagRecord(name);
  if (!flag) throw new Error(`Feature flag '${name}' not found`);
  if (!RULE_TYPES.includes(ruleType)) {
    throw new Error(`ruleType must be one of: ${RULE_TYPES.join(", ")}`);
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("rule value is required");
  }

  const rule = addFlagRuleRecord({ flagId: flag.id, ruleType, value, enabled });
  addFlagHistoryRecord({
    flagId: flag.id,
    flagName: flag.name,
    action: "rule_add",
    changedBy,
    newValue: rule,
    reason: `Rule for ${ruleType} ${value}`,
  });
  invalidateCache();
  return rule;
}

export function removeRule(name, ruleId, changedBy = "system") {
  const flag = getFlagRecord(name);
  if (!flag) throw new Error(`Feature flag '${name}' not found`);

  const rule = getFlagRuleRecord(Number(ruleId));
  if (!rule || rule.flagId !== flag.id) {
    throw new Error(`Rule ${ruleId} not found for flag '${name}'`);
  }

  deleteFlagRuleRecord(rule.id);
  addFlagHistoryRecord({
    flagId: flag.id,
    flagName: flag.name,
    action: "rule_remove",
    changedBy,
    oldValue: rule,
    reason: `Removed rule ${rule.id}`,
  });
  invalidateCache();
  return true;
}

// ── Rollout & rollback ────────────────────────────────────────────────────────

/**
 * Set the rollout percentage for a flag. Clears the kill switch because an
 * operator explicitly resuming a rollout should be able to do so.
 */
export function setRollout(name, percentage, changedBy = "system") {
  const flag = getFlagRecord(name);
  if (!flag) throw new Error(`Feature flag '${name}' not found`);
  if (typeof percentage !== "number" || percentage < 0 || percentage > 100) {
    throw new Error("percentage must be a number between 0 and 100");
  }

  const updated = updateFlagRecord(flag.id, {
    rolloutPercentage: percentage,
    enabled: percentage > 0,
    killed: false,
  });
  addFlagHistoryRecord({
    flagId: flag.id,
    flagName: flag.name,
    action: "rollout",
    changedBy,
    oldValue: flag.rolloutPercentage,
    newValue: percentage,
    reason: `Rollout set to ${percentage}%`,
  });
  invalidateCache();
  logger.info("Feature flag rollout updated", { name, percentage, changedBy });
  return updated;
}

/**
 * Instantly and safely disable a flag. The kill switch is evaluated before
 * rules, so a rollback takes effect for every caller immediately.
 */
export function rollback(name, changedBy = "system", reason = "Rolled back") {
  const flag = getFlagRecord(name);
  if (!flag) throw new Error(`Feature flag '${name}' not found`);

  const updated = updateFlagRecord(flag.id, { enabled: false, killed: true });
  addFlagHistoryRecord({
    flagId: flag.id,
    flagName: flag.name,
    action: "rollback",
    changedBy,
    oldValue: flag,
    newValue: updated,
    reason,
  });
  invalidateCache();
  logger.warn("Feature flag rolled back", { name, changedBy, reason });
  return updated;
}

export function getHistory(name) {
  const flag = getFlagRecord(name);
  if (!flag) throw new Error(`Feature flag '${name}' not found`);
  return getFlagHistoryRecords(flag.id);
}

// ── Metrics, monitoring & auto-rollback ───────────────────────────────────────

/**
 * Record a metric sample for a flag. `metricType` is one of request/error/
 * latency; latency values are milliseconds.
 */
export function recordMetric(name, { metricType, value = 0 }) {
  const flag = getFlagRecord(name);
  if (!flag) throw new Error(`Feature flag '${name}' not found`);
  if (!METRIC_TYPES.includes(metricType)) {
    throw new Error(`metricType must be one of: ${METRIC_TYPES.join(", ")}`);
  }
  return addFlagMetricRecord({ flagId: flag.id, flagName: flag.name, metricType, value });
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, rank)];
}

/**
 * Aggregate a flag's metrics over the trailing `windowMs` window.
 */
export function getMetrics(name, { windowMs = 3600_000 } = {}) {
  const flag = getFlagRecord(name);
  if (!flag) throw new Error(`Feature flag '${name}' not found`);

  const since = new Date(Date.now() - windowMs).toISOString();
  const samples = getFlagMetricRecords(flag.id, since);

  const requests = samples.filter((s) => s.metricType === "request").length;
  const errorSamples = samples.filter((s) => s.metricType === "error");
  const errors = errorSamples.reduce((sum, s) => sum + (Number(s.value) || 1), 0);
  const latencies = samples
    .filter((s) => s.metricType === "latency")
    .map((s) => Number(s.value))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);

  const avgLatency = latencies.length
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length
    : null;

  // errorRate is relative to recorded requests, falling back to the number of
  // error samples when no request samples were reported.
  const denominator = requests > 0 ? requests : errorSamples.length;
  const errorRate = denominator > 0 ? errors / denominator : 0;

  return {
    flag: flag.name,
    windowMs,
    requests,
    errors,
    errorRate,
    sampleCount: samples.length,
    avgLatencyMs: avgLatency == null ? null : Math.round(avgLatency * 100) / 100,
    p95LatencyMs: percentile(latencies, 95),
    maxLatencyMs: latencies.length ? latencies[latencies.length - 1] : null,
  };
}

export function getThresholds(overrides = {}) {
  const maxErrorRate =
    overrides.maxErrorRate ??
    Number(process.env.FEATURE_FLAG_MAX_ERROR_RATE ?? DEFAULT_MAX_ERROR_RATE);
  const maxP95LatencyMs =
    overrides.maxP95LatencyMs ??
    Number(process.env.FEATURE_FLAG_MAX_P95_LATENCY_MS ?? DEFAULT_MAX_P95_LATENCY_MS);
  return { maxErrorRate, maxP95LatencyMs };
}

/**
 * Evaluate whether a rolling-out flag is healthy against the error-rate and
 * latency thresholds. Returns the metrics plus any breached reasons.
 */
export function checkRolloutHealth(name, thresholds = {}) {
  const { maxErrorRate, maxP95LatencyMs } = getThresholds(thresholds);
  const windowMs = thresholds.windowMs ?? 3600_000;
  const metrics = getMetrics(name, { windowMs });

  const reasons = [];
  if (metrics.requests > 0 && metrics.errorRate > maxErrorRate) {
    reasons.push(
      `Error rate ${(metrics.errorRate * 100).toFixed(2)}% exceeds ${(maxErrorRate * 100).toFixed(2)}%`,
    );
  }
  if (metrics.p95LatencyMs != null && metrics.p95LatencyMs > maxP95LatencyMs) {
    reasons.push(`p95 latency ${metrics.p95LatencyMs}ms exceeds ${maxP95LatencyMs}ms`);
  }

  return {
    flag: name,
    healthy: reasons.length === 0,
    reasons,
    thresholds: { maxErrorRate, maxP95LatencyMs, windowMs },
    metrics,
  };
}

/**
 * Monitor a flag and roll it back automatically when unhealthy. Returns the
 * health report and whether a rollback was performed.
 */
export function monitorRollout(name, { thresholds = {}, autoRollback = true, changedBy = "system" } = {}) {
  const health = checkRolloutHealth(name, thresholds);
  let rolledBack = false;

  if (!health.healthy && autoRollback) {
    rollback(name, changedBy, `Auto-rollback: ${health.reasons.join("; ")}`);
    rolledBack = true;
  }

  return { ...health, rolledBack };
}
