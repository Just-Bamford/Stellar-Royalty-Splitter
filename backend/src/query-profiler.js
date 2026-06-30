import { performance } from "node:perf_hooks";
import logger from "./logger.js";

const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 100;
const MAX_SLOW_QUERY_SAMPLES = 50;

const metrics = {
  totalQueries: 0,
  slowQueries: 0,
  totalDurationMs: 0,
  maxDurationMs: 0,
  byOperation: new Map(),
  slowQuerySamples: [],
};

function getSlowQueryThresholdMs() {
  const parsed = Number.parseInt(process.env.SLOW_QUERY_THRESHOLD_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SLOW_QUERY_THRESHOLD_MS;
}

function normalizeSql(sql) {
  return String(sql ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function addOperationMetric(operation, durationMs) {
  const current = metrics.byOperation.get(operation) ?? {
    count: 0,
    slowCount: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  };

  current.count += 1;
  current.totalDurationMs += durationMs;
  current.maxDurationMs = Math.max(current.maxDurationMs, durationMs);
  if (durationMs >= getSlowQueryThresholdMs()) {
    current.slowCount += 1;
  }

  metrics.byOperation.set(operation, current);
}

function getRecommendations(sql, durationMs) {
  const normalized = normalizeSql(sql).toUpperCase();
  const recommendations = [];

  if (normalized.includes(" JOIN ") && !normalized.includes(" LIMIT ")) {
    recommendations.push("Check join keys and add a LIMIT when the caller does not need the full result set.");
  }

  if (normalized.includes("ORDER BY") && !normalized.includes("LIMIT")) {
    recommendations.push("Add a LIMIT or a covering index for the ORDER BY columns.");
  }

  if (normalized.includes("GROUP BY")) {
    recommendations.push("Verify GROUP BY columns are backed by a composite index with the WHERE filters.");
  }

  if (durationMs >= getSlowQueryThresholdMs() * 2) {
    recommendations.push("Run EXPLAIN QUERY PLAN for this statement and consider a targeted composite index.");
  }

  if (recommendations.length === 0) {
    recommendations.push("Review cardinality, indexes, and caller-side caching for this query shape.");
  }

  return recommendations;
}

function recordQuery(sql, operation, durationMs) {
  const thresholdMs = getSlowQueryThresholdMs();
  const roundedDuration = Math.round(durationMs * 100) / 100;
  const normalizedSql = normalizeSql(sql);

  metrics.totalQueries += 1;
  metrics.totalDurationMs += roundedDuration;
  metrics.maxDurationMs = Math.max(metrics.maxDurationMs, roundedDuration);
  addOperationMetric(operation, roundedDuration);

  if (roundedDuration < thresholdMs) {
    return;
  }

  const sample = {
    sql: normalizedSql,
    operation,
    durationMs: roundedDuration,
    thresholdMs,
    observedAt: new Date().toISOString(),
    recommendations: getRecommendations(normalizedSql, roundedDuration),
  };

  metrics.slowQueries += 1;
  metrics.slowQuerySamples.unshift(sample);
  metrics.slowQuerySamples = metrics.slowQuerySamples.slice(0, MAX_SLOW_QUERY_SAMPLES);

  logger.warn("Slow database query detected", sample);
}

export function profileQueryExecution(sql, operation, execute) {
  const startedAt = performance.now();
  try {
    return execute();
  } finally {
    recordQuery(sql, operation, performance.now() - startedAt);
  }
}

function instrumentStatement(statement, sql) {
  return new Proxy(statement, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (!["get", "all", "run", "iterate"].includes(prop) || typeof value !== "function") {
        return value;
      }

      return (...args) =>
        profileQueryExecution(sql, prop, () => value.apply(target, args));
    },
  });
}

export function instrumentDatabase(database) {
  if (!database || database.__queryProfilerInstalled) {
    return database;
  }

  const installFlag = (target) =>
    Object.defineProperty(target, "__queryProfilerInstalled", {
      value: true,
      enumerable: false,
    });

  try {
    const originalPrepare = database.prepare.bind(database);
    database.prepare = (sql, ...args) => instrumentStatement(originalPrepare(sql, ...args), sql);
    installFlag(database);
    return database;
  } catch (_) {
    const proxied = new Proxy(database, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql, ...args) =>
            instrumentStatement(target.prepare.call(target, sql, ...args), sql);
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    installFlag(proxied);
    return proxied;
  }
}

export function getQueryProfilerMetrics() {
  const operationMetrics = {};
  for (const [operation, data] of metrics.byOperation.entries()) {
    operationMetrics[operation] = {
      count: data.count,
      slowCount: data.slowCount,
      averageDurationMs:
        data.count === 0 ? 0 : Math.round((data.totalDurationMs / data.count) * 100) / 100,
      maxDurationMs: data.maxDurationMs,
    };
  }

  return {
    enabled: true,
    thresholdMs: getSlowQueryThresholdMs(),
    totalQueries: metrics.totalQueries,
    slowQueries: metrics.slowQueries,
    averageDurationMs:
      metrics.totalQueries === 0
        ? 0
        : Math.round((metrics.totalDurationMs / metrics.totalQueries) * 100) / 100,
    maxDurationMs: metrics.maxDurationMs,
    operations: operationMetrics,
    slowQuerySamples: metrics.slowQuerySamples,
  };
}

export function resetQueryProfilerMetrics() {
  metrics.totalQueries = 0;
  metrics.slowQueries = 0;
  metrics.totalDurationMs = 0;
  metrics.maxDurationMs = 0;
  metrics.byOperation.clear();
  metrics.slowQuerySamples = [];
}
