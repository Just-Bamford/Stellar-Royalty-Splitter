import { db, countWrite } from "./core.js";

const LEVELS = new Set(["error", "warn", "info", "debug"]);
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_ALERT_WINDOW_MINUTES = 5;
const DEFAULT_ERROR_THRESHOLD = 10;

function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return {};
  try {
    return JSON.parse(JSON.stringify(metadata));
  } catch {
    return { serializationError: true };
  }
}

export function appendApplicationLog({
  level = "info",
  message,
  correlationId = null,
  requestId = null,
  service = "api",
  metadata = {},
}) {
  const normalizedLevel = LEVELS.has(level) ? level : "info";
  if (!message) return;
  try {
    db.prepare(
      `INSERT INTO application_logs
        (level, message, correlation_id, request_id, service, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      normalizedLevel,
      String(message).slice(0, 2000),
      correlationId,
      requestId,
      String(service).slice(0, 120),
      JSON.stringify(safeMetadata(metadata)),
    );
    countWrite();
  } catch {
    // Logging must never take down the request that it is recording.
  }
}

export function queryApplicationLogs({
  level,
  correlationId,
  requestId,
  service,
  search,
  from,
  to,
  limit = 100,
  offset = 0,
} = {}) {
  const clauses = [];
  const params = [];
  if (level && LEVELS.has(level)) {
    clauses.push("level = ?");
    params.push(level);
  }
  if (correlationId) {
    clauses.push("correlation_id = ?");
    params.push(correlationId);
  }
  if (requestId) {
    clauses.push("request_id = ?");
    params.push(requestId);
  }
  if (service) {
    clauses.push("service = ?");
    params.push(service);
  }
  if (from) {
    clauses.push("timestamp >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("timestamp <= ?");
    params.push(to);
  }
  if (search) {
    clauses.push("(message LIKE ? OR metadata LIKE ?)");
    const pattern = `%${String(search).slice(0, 120)}%`;
    params.push(pattern, pattern);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const rows = db
    .prepare(
      `SELECT id, timestamp, level, message, correlation_id AS correlationId,
              request_id AS requestId, service, metadata
       FROM application_logs ${where}
       ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, safeLimit, safeOffset);
  return rows.map((row) => ({
    ...row,
    metadata: JSON.parse(row.metadata || "{}"),
  }));
}

export function countApplicationLogs(filters = {}) {
  const rows = queryApplicationLogs({ ...filters, limit: 500, offset: 0 });
  return rows.length;
}

export function pruneApplicationLogs(retentionDays = DEFAULT_RETENTION_DAYS) {
  const days = Math.min(Math.max(Number(retentionDays) || DEFAULT_RETENTION_DAYS, 1), 3650);
  const result = db
    .prepare("DELETE FROM application_logs WHERE timestamp < datetime('now', ?)")
    .run(`-${days} days`);
  return { deleted: result.changes, retentionDays: days };
}

export function evaluateLogAlerts({
  windowMinutes = DEFAULT_ALERT_WINDOW_MINUTES,
  errorThreshold = DEFAULT_ERROR_THRESHOLD,
} = {}) {
  const minutes = Math.min(Math.max(Number(windowMinutes) || DEFAULT_ALERT_WINDOW_MINUTES, 1), 1440);
  const threshold = Math.max(Number(errorThreshold) || DEFAULT_ERROR_THRESHOLD, 1);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS errorCount, MAX(timestamp) AS lastError
       FROM application_logs
       WHERE level = 'error' AND timestamp >= datetime('now', ?)`,
    )
    .get(`-${minutes} minutes`);
  return {
    triggered: row.errorCount >= threshold,
    errorCount: row.errorCount,
    threshold,
    windowMinutes: minutes,
    lastError: row.lastError ?? null,
  };
}

export { DEFAULT_RETENTION_DAYS };
