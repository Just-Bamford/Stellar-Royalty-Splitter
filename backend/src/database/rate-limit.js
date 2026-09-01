/**
 * Database functions for API key management and rate-limit usage tracking (#608).
 *
 * Tables:
 *   api_keys            — registered API keys with per-key rate limits and metadata
 *   rate_limit_events   — per-minute request/block counts per key (rolling ring buffer)
 */

import { db, countWrite } from "./core.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Default per-minute request limit for authenticated API keys.
 * Can be overridden per key in the api_keys table.
 */
export const DEFAULT_AUTH_LIMIT_PER_MINUTE = 1000;

/**
 * Default per-minute request limit for unauthenticated (IP-based) access.
 */
export const DEFAULT_IP_LIMIT_PER_MINUTE = 100;

/**
 * Fraction of the limit at which an alert is considered "approaching".
 * e.g. 0.8 means alert when usage >= 80% of limit.
 */
export const ALERT_THRESHOLD_FRACTION = 0.8;

/**
 * How many minutes of history to retain in rate_limit_events.
 * Older rows are pruned on each record call.
 */
export const HISTORY_RETENTION_MINUTES = 60 * 24; // 24 hours

// ─── Prepared statements (lazy-initialized) ───────────────────────────────────

let _stmts = null;

function stmts() {
  if (_stmts) return _stmts;

  _stmts = {
    upsertEvent: db.prepare(`
      INSERT INTO rate_limit_events (key_id, bucket_minute, request_count, blocked_count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key_id, bucket_minute) DO UPDATE SET
        request_count = request_count + excluded.request_count,
        blocked_count = blocked_count + excluded.blocked_count
    `),

    pruneOldEvents: db.prepare(`
      DELETE FROM rate_limit_events
      WHERE bucket_minute < strftime('%Y-%m-%dT%H:%M', 'now', '-' || ? || ' minutes')
    `),

    getKeyByValue: db.prepare(`
      SELECT id, key_value, label, custom_limit_per_minute, created_at, last_seen_at
      FROM api_keys
      WHERE key_value = ?
    `),

    getKeyById: db.prepare(`
      SELECT id, key_value, label, custom_limit_per_minute, created_at, last_seen_at
      FROM api_keys
      WHERE id = ?
    `),

    getAllKeys: db.prepare(`
      SELECT id, key_value, label, custom_limit_per_minute, created_at, last_seen_at
      FROM api_keys
      ORDER BY created_at DESC
    `),

    upsertKey: db.prepare(`
      INSERT INTO api_keys (key_value, label, custom_limit_per_minute)
      VALUES (?, ?, ?)
      ON CONFLICT(key_value) DO UPDATE SET
        label = excluded.label,
        last_seen_at = CURRENT_TIMESTAMP
    `),

    touchKey: db.prepare(`
      UPDATE api_keys SET last_seen_at = CURRENT_TIMESTAMP WHERE key_value = ?
    `),

    updateLimit: db.prepare(`
      UPDATE api_keys SET custom_limit_per_minute = ? WHERE key_value = ?
    `),

    // Current-window usage (last 60 seconds, i.e. the current or previous minute bucket)
    getCurrentWindowUsage: db.prepare(`
      SELECT COALESCE(SUM(request_count), 0) AS request_count,
             COALESCE(SUM(blocked_count), 0) AS blocked_count
      FROM rate_limit_events
      WHERE key_id = ?
        AND bucket_minute >= strftime('%Y-%m-%dT%H:%M', 'now', '-1 minutes')
    `),

    // Historical usage — one row per minute for the last N minutes
    getHistoricalUsage: db.prepare(`
      SELECT bucket_minute, request_count, blocked_count
      FROM rate_limit_events
      WHERE key_id = ?
        AND bucket_minute >= strftime('%Y-%m-%dT%H:%M', 'now', '-' || ? || ' minutes')
      ORDER BY bucket_minute ASC
    `),

    // Aggregate totals for the last N minutes (for the dashboard summary)
    getAggregateUsage: db.prepare(`
      SELECT COALESCE(SUM(request_count), 0) AS total_requests,
             COALESCE(SUM(blocked_count), 0) AS total_blocked,
             COUNT(DISTINCT bucket_minute) AS active_minutes
      FROM rate_limit_events
      WHERE key_id = ?
        AND bucket_minute >= strftime('%Y-%m-%dT%H:%M', 'now', '-' || ? || ' minutes')
    `),

    // All-keys aggregate for the overview endpoint
    getAllKeysWithCurrentUsage: db.prepare(`
      SELECT
        k.id,
        k.key_value,
        k.label,
        k.custom_limit_per_minute,
        k.created_at,
        k.last_seen_at,
        COALESCE(SUM(e.request_count), 0) AS current_requests,
        COALESCE(SUM(e.blocked_count), 0) AS current_blocked
      FROM api_keys k
      LEFT JOIN rate_limit_events e
        ON e.key_id = k.id
        AND e.bucket_minute >= strftime('%Y-%m-%dT%H:%M', 'now', '-1 minutes')
      GROUP BY k.id
      ORDER BY current_requests DESC, k.created_at DESC
    `),
  };

  return _stmts;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Returns the current UTC minute bucket string, e.g. "2024-01-15T14:32".
 */
function currentBucket() {
  return new Date().toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
}

/**
 * Ensures an api_keys row exists for the given key value and returns its id.
 * @param {string} keyValue - The raw API key string from x-api-key header
 * @returns {number} The db row id for this key
 */
function ensureKeyRow(keyValue) {
  stmts().upsertKey.run(keyValue, null, null);
  const row = stmts().getKeyByValue.get(keyValue);
  return row.id;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a request event for an API key.
 * Called from the rate limiter middleware on every authenticated request.
 *
 * @param {string} keyValue - The raw API key value
 * @param {boolean} [blocked=false] - Whether this request was blocked (429)
 */
export function recordApiKeyRequest(keyValue, blocked = false) {
  if (!keyValue) return;

  const keyId = ensureKeyRow(keyValue);
  const bucket = currentBucket();

  stmts().upsertEvent.run(keyId, bucket, 1, blocked ? 1 : 0);
  stmts().touchKey.run(keyValue);
  stmts().pruneOldEvents.run(HISTORY_RETENTION_MINUTES);

  countWrite();
}

/**
 * Get the current-window usage stats for a single API key.
 *
 * @param {string} keyValue
 * @returns {{ requestsPerMinute: number, blockedPerMinute: number, limit: number, percentUsed: number, approaching: boolean } | null}
 */
export function getApiKeyCurrentUsage(keyValue) {
  const row = stmts().getKeyByValue.get(keyValue);
  if (!row) return null;

  const usage = stmts().getCurrentWindowUsage.get(row.id);
  const limit = row.custom_limit_per_minute ?? DEFAULT_AUTH_LIMIT_PER_MINUTE;
  const requestsPerMinute = usage.request_count;
  const percentUsed = limit > 0 ? Math.min((requestsPerMinute / limit) * 100, 100) : 0;

  return {
    keyValue: row.key_value,
    label: row.label,
    requestsPerMinute,
    blockedPerMinute: usage.blocked_count,
    limit,
    percentUsed: Math.round(percentUsed * 10) / 10,
    approaching: percentUsed >= ALERT_THRESHOLD_FRACTION * 100,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

/**
 * Get the historical per-minute usage for a single API key.
 *
 * @param {string} keyValue
 * @param {number} [minutes=60] - How many minutes of history to return
 * @returns {{ history: Array<{bucket: string, requests: number, blocked: number}>, aggregate: object } | null}
 */
export function getApiKeyHistory(keyValue, minutes = 60) {
  const clampedMinutes = Math.min(Math.max(parseInt(minutes) || 60, 1), HISTORY_RETENTION_MINUTES);
  const row = stmts().getKeyByValue.get(keyValue);
  if (!row) return null;

  const rawHistory = stmts().getHistoricalUsage.all(row.id, clampedMinutes);
  const aggregate = stmts().getAggregateUsage.get(row.id, clampedMinutes);
  const limit = row.custom_limit_per_minute ?? DEFAULT_AUTH_LIMIT_PER_MINUTE;

  return {
    keyValue: row.key_value,
    label: row.label,
    limit,
    windowMinutes: clampedMinutes,
    history: rawHistory.map((r) => ({
      bucket: r.bucket_minute,
      requests: r.request_count,
      blocked: r.blocked_count,
    })),
    aggregate: {
      totalRequests: aggregate.total_requests,
      totalBlocked: aggregate.total_blocked,
      activeMinutes: aggregate.active_minutes,
    },
  };
}

/**
 * Get current usage for all registered API keys — used for the dashboard overview.
 *
 * @returns {Array<object>}
 */
export function getAllApiKeysUsage() {
  const rows = stmts().getAllKeysWithCurrentUsage.all();
  return rows.map((row) => {
    const limit = row.custom_limit_per_minute ?? DEFAULT_AUTH_LIMIT_PER_MINUTE;
    const percentUsed = limit > 0 ? Math.min((row.current_requests / limit) * 100, 100) : 0;

    return {
      keyValue: row.key_value,
      label: row.label,
      requestsPerMinute: row.current_requests,
      blockedPerMinute: row.current_blocked,
      limit,
      percentUsed: Math.round(percentUsed * 10) / 10,
      approaching: percentUsed >= ALERT_THRESHOLD_FRACTION * 100,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
    };
  });
}

/**
 * Update the rate limit for a specific API key.
 *
 * @param {string} keyValue
 * @param {number|null} limitPerMinute - New limit, or null to revert to the default
 * @returns {boolean} true if the key was found and updated, false otherwise
 */
export function setApiKeyLimit(keyValue, limitPerMinute) {
  const info = stmts().updateLimit.run(limitPerMinute, keyValue);
  if (info.changes === 0) return false;
  countWrite();
  return true;
}

/**
 * Register or update an API key's label.
 * Creates the key row if it doesn't already exist.
 *
 * @param {string} keyValue
 * @param {string|null} label
 */
export function registerApiKey(keyValue, label = null) {
  stmts().upsertKey.run(keyValue, label, null);
  countWrite();
}

/**
 * Returns alert entries for keys currently approaching or exceeding their limit.
 * Used to power the "alert when approaching limit" acceptance criterion.
 *
 * @returns {Array<{keyValue: string, label: string|null, requestsPerMinute: number, limit: number, percentUsed: number}>}
 */
export function getApproachingLimitAlerts() {
  const all = getAllApiKeysUsage();
  return all.filter((k) => k.approaching);
}
