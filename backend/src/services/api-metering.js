/**
 * API metering, tiered rate limiting and usage-based pricing for
 * third-party marketplace partners — closes #996.
 *
 * Responsibilities:
 *   - Issue and revoke partner API keys (only the SHA-256 hash is persisted)
 *   - Track every call made with a partner key
 *   - Enforce per-tier rate limits (free / pro / enterprise)
 *   - Price usage per tier and attribute revenue to each partner
 *   - Aggregate the partner analytics the dashboard renders
 *
 * Related files:
 *   src/middleware/api-key-auth.js — authenticates keys and enforces limits
 *   src/routes/partner-api.js     — partner-facing and admin-facing endpoints
 */

import { randomBytes, createHash } from "crypto";
import { db, countWrite } from "../database/core.js";
import logger from "../logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const TIERS = ["free", "pro", "enterprise"];

/**
 * Tier catalogue. `dailyLimit`/`monthlyLimit` are the number of billable calls;
 * `null` means the tier is not capped on that axis.
 */
export const PRICING_TIERS = Object.freeze({
  free: Object.freeze({
    tier: "free",
    label: "Free",
    dailyLimit: 100,
    monthlyLimit: null,
    monthlyPriceCents: 0,
    overageUnitPriceCents: null,
    description: "100 calls/day, free forever. Rate limited when the daily quota is exhausted.",
  }),
  pro: Object.freeze({
    tier: "pro",
    label: "Pro",
    dailyLimit: null,
    monthlyLimit: 10_000,
    monthlyPriceCents: 5_000,
    overageUnitPriceCents: 1,
    description: "$50/month for 10,000 calls, then $0.01 per additional call.",
  }),
  enterprise: Object.freeze({
    tier: "enterprise",
    label: "Enterprise",
    dailyLimit: null,
    monthlyLimit: null,
    monthlyPriceCents: 0,
    overageUnitPriceCents: null,
    description: "Custom daily and monthly limits, negotiated pricing and SLA.",
  }),
});

/** Calls retained in api_call_events before pruning. */
export const DEFAULT_RETENTION_DAYS = 90;

/** Longest window the "calls over time" chart can report. */
export const MAX_ANALYTICS_DAYS = 365;

// ─── Time helpers (all UTC) ───────────────────────────────────────────────────

/** "YYYY-MM-DD" for the day containing `date`. */
export function dayBucket(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

/** "YYYY-MM" for the month containing `date`. */
export function monthBucket(date = new Date()) {
  return new Date(date).toISOString().slice(0, 7);
}

/** Start of the current UTC day as "YYYY-MM-DD". */
function currentDayStart() {
  return dayBucket(new Date());
}

/** First day of the current UTC month as "YYYY-MM-DD". */
function currentMonthStart() {
  return `${monthBucket(new Date())}-01`;
}

/**
 * ISO timestamp of the next UTC midnight — when a daily quota resets.
 */
export function nextUtcMidnight(date = new Date()) {
  const next = new Date(date);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

/**
 * ISO timestamp of the first instant of the next UTC month — when a monthly
 * quota resets.
 */
export function nextUtcMonthStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
}

/** "YYYY-MM-DD" for `days` days before today. */
function daysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return dayBucket(d);
}

/** Clamp a user-supplied day window to a sane range. */
function clampDays(days, fallback = 30) {
  const parsed = parseInt(days, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), MAX_ANALYTICS_DAYS);
}

// ─── Prepared statements ──────────────────────────────────────────────────────

let _stmts = null;

function stmts() {
  if (_stmts) return _stmts;
  if (!db.open) return null;

  _stmts = {
    insertKey: db.prepare(`
      INSERT INTO partner_api_keys
        (keyId, keyHash, partnerId, partnerName, tier, dailyCallLimit, monthlyCallLimit, monthlyPriceCents, expiresAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    getByHash: db.prepare(`
      SELECT * FROM partner_api_keys WHERE keyHash = ?
    `),

    getById: db.prepare(`
      SELECT * FROM partner_api_keys WHERE id = ?
    `),

    getByKeyId: db.prepare(`
      SELECT * FROM partner_api_keys WHERE keyId = ?
    `),

    listByPartner: db.prepare(`
      SELECT * FROM partner_api_keys
      WHERE partnerId = ?
      ORDER BY createdAt DESC
    `),

    listAll: db.prepare(`
      SELECT * FROM partner_api_keys
      ORDER BY createdAt DESC
    `),

    listActive: db.prepare(`
      SELECT * FROM partner_api_keys
      WHERE status = 'active'
      ORDER BY createdAt DESC
    `),

    revokeById: db.prepare(`
      UPDATE partner_api_keys
      SET status = 'revoked', revokedAt = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'active'
    `),

    touch: db.prepare(`
      UPDATE partner_api_keys SET lastUsedAt = CURRENT_TIMESTAMP WHERE id = ?
    `),

    updateTier: db.prepare(`
      UPDATE partner_api_keys
      SET tier = ?, dailyCallLimit = ?, monthlyCallLimit = ?, monthlyPriceCents = ?
      WHERE id = ?
    `),

    // Billable calls only — throttled requests are stored but never charged.
    countDay: db.prepare(`
      SELECT COUNT(*) AS c FROM api_call_events
      WHERE keyId = ? AND bucketDay = ? AND rateLimited = 0
    `),

    countMonth: db.prepare(`
      SELECT COUNT(*) AS c FROM api_call_events
      WHERE keyId = ? AND bucketDay >= ? AND rateLimited = 0
    `),

    insertEvent: db.prepare(`
      INSERT INTO api_call_events
        (keyId, partnerId, endpoint, method, statusCode, durationMs, rateLimited, bucketDay)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),

    pruneEvents: db.prepare(`
      DELETE FROM api_call_events WHERE bucketDay < ?
    `),

    partnerTotals: db.prepare(`
      SELECT k.partnerId AS partnerId,
             k.partnerName AS partnerName,
             k.tier AS tier,
             k.monthlyPriceCents AS monthlyPriceCents,
             k.monthlyCallLimit AS monthlyCallLimit,
             k.status AS status,
             COALESCE(SUM(CASE WHEN e.rateLimited = 0 THEN 1 ELSE 0 END), 0) AS calls,
             SUM(CASE WHEN e.statusCode >= 400 THEN 1 ELSE 0 END) AS errors
      FROM partner_api_keys k
      LEFT JOIN api_call_events e
        ON e.keyId = k.keyId AND e.bucketDay >= ? AND e.bucketDay <= ?
      GROUP BY k.partnerId, k.tier, k.monthlyPriceCents, k.monthlyCallLimit, k.status, k.partnerName
    `),
  };

  return _stmts;
}

/**
 * Analytics statements, in two cached variants: one unfiltered and one that
 * adds `AND partnerId = ?`. The filter has to be baked into the SQL when the
 * statement is prepared, so caching both variants keeps the parameter order
 * stable without preparing a new statement per partner.
 */
let _scopedStmts = null;
let _unscopedStmts = null;

function analyticsStmts(scoped) {
  if (scoped ? _scopedStmts : _unscopedStmts) return scoped ? _scopedStmts : _unscopedStmts;
  if (!db.open) return null;

  const filter = scoped ? "AND partnerId = ?" : "";
  const prepared = {
    usageOverTime: db.prepare(`
      SELECT bucketDay AS day,
             COUNT(*) AS calls,
             SUM(CASE WHEN rateLimited = 1 THEN 1 ELSE 0 END) AS rateLimited,
             SUM(CASE WHEN statusCode >= 400 THEN 1 ELSE 0 END) AS errors,
             COALESCE(AVG(durationMs), 0) AS avgDurationMs
      FROM api_call_events
      WHERE bucketDay >= ? AND bucketDay <= ? ${filter}
      GROUP BY bucketDay
      ORDER BY bucketDay ASC
    `),

    topEndpoints: db.prepare(`
      SELECT endpoint AS endpoint,
             method AS method,
             COUNT(*) AS calls,
             SUM(CASE WHEN statusCode >= 400 THEN 1 ELSE 0 END) AS errors,
             COALESCE(AVG(durationMs), 0) AS avgDurationMs
      FROM api_call_events
      WHERE bucketDay >= ? AND bucketDay <= ? ${filter}
      GROUP BY endpoint, method
      ORDER BY calls DESC
      LIMIT ?
    `),

    totals: db.prepare(`
      SELECT COUNT(*) AS totalCalls,
             SUM(CASE WHEN statusCode >= 400 THEN 1 ELSE 0 END) AS totalErrors,
             SUM(CASE WHEN statusCode >= 500 THEN 1 ELSE 0 END) AS serverErrors,
             SUM(CASE WHEN rateLimited = 1 THEN 1 ELSE 0 END) AS totalRateLimited,
             COALESCE(AVG(durationMs), 0) AS avgDurationMs
      FROM api_call_events
      WHERE bucketDay >= ? AND bucketDay <= ? ${filter}
    `),

    statusBreakdown: db.prepare(`
      SELECT statusCode AS statusCode, COUNT(*) AS calls
      FROM api_call_events
      WHERE bucketDay >= ? AND bucketDay <= ? ${filter}
      GROUP BY statusCode
      ORDER BY calls DESC
    `),
  };

  if (scoped) _scopedStmts = prepared;
  else _unscopedStmts = prepared;
  return prepared;
}

/**
 * Run one of the analytics statements, binding the partner filter when the
 * query is scoped to a single partner.
 */
function withPartner(stmt, since, until, partnerId, tail = []) {
  return partnerId ? stmt.all(since, until, partnerId, ...tail) : stmt.all(since, until, ...tail);
}

// ─── Key issuance ─────────────────────────────────────────────────────────────

/** SHA-256 hex digest of a plaintext key. */
export function hashApiKey(plaintext) {
  return createHash("sha256").update(String(plaintext)).digest("hex");
}

/**
 * Mint a plaintext API key. Only the returned value is ever shown to the
 * partner; the server stores `hashApiKey(plaintext)` only.
 */
export function generateApiKey() {
  return `srs_live_${randomBytes(24).toString("hex")}`;
}

/** Short, non-secret public identifier for a key (safe to show in the UI). */
export function generateKeyId() {
  return `key_${randomBytes(8).toString("hex")}`;
}

/**
 * Issue a new API key for a marketplace partner.
 *
 * @param {object} options
 * @param {string} options.partnerId       - Stable partner identifier
 * @param {string} options.partnerName     - Human readable partner name
 * @param {string} [options.tier="free"]   - free | pro | enterprise
 * @param {number|null} [options.dailyCallLimit]   - Overrides the tier default
 * @param {number|null} [options.monthlyCallLimit] - Overrides the tier default
 * @param {string|null} [options.expiresAt] - Optional ISO expiry timestamp
 * @returns {{id, keyId, keyHash, apiKey, partnerId, partnerName, tier, dailyCallLimit, monthlyCallLimit}}
 */
export function issueApiKey({
  partnerId,
  partnerName,
  tier = "free",
  dailyCallLimit,
  monthlyCallLimit,
  monthlyPriceCents,
  expiresAt = null,
} = {}) {
  if (!partnerId || typeof partnerId !== "string" || !partnerId.trim()) {
    throw new Error("partnerId is required");
  }
  if (!TIERS.includes(tier)) {
    throw new Error(`Unknown tier: ${tier}. Expected one of ${TIERS.join(", ")}`);
  }

  const statements = stmts();
  if (!statements) throw new Error("Database is not available");

  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  const keyId = generateKeyId();

  // `undefined` means "inherit the tier default" and is stored as NULL.
  const daily =
    dailyCallLimit === undefined || dailyCallLimit === null
      ? PRICING_TIERS[tier].dailyLimit
      : Number(dailyCallLimit);
  const monthly =
    monthlyCallLimit === undefined || monthlyCallLimit === null
      ? PRICING_TIERS[tier].monthlyLimit
      : Number(monthlyCallLimit);
  const price =
    monthlyPriceCents === undefined || monthlyPriceCents === null
      ? PRICING_TIERS[tier].monthlyPriceCents
      : Number(monthlyPriceCents);

  const result = statements.insertKey.run(
    keyId,
    keyHash,
    partnerId.trim(),
    partnerName?.trim() || partnerId.trim(),
    tier,
    daily,
    monthly,
    price,
    expiresAt
  );
  countWrite();

  logger.info("Partner API key issued", { keyId, partnerId, tier });

  return {
    id: Number(result.lastInsertRowid),
    keyId,
    keyHash,
    apiKey,
    partnerId: partnerId.trim(),
    partnerName: partnerName?.trim() || partnerId.trim(),
    tier,
    dailyCallLimit: daily,
    monthlyCallLimit: monthly,
    monthlyPriceCents: price,
    expiresAt,
  };
}

/** Shape a DB row into the public key record (never includes the hash). */
function toKeyRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    keyId: row.keyId,
    partnerId: row.partnerId,
    partnerName: row.partnerName,
    tier: row.tier,
    dailyCallLimit: row.dailyCallLimit,
    monthlyCallLimit: row.monthlyCallLimit,
    monthlyPriceCents: row.monthlyPriceCents ?? 0,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * Resolve a plaintext key to its stored record.
 *
 * Returns null for unknown keys. Returns the record with `reason` set for keys
 * that are known but not currently usable (revoked / expired) so the caller can
 * return an accurate error.
 *
 * @param {string} plaintext
 * @returns {{id, keyId, partnerId, partnerName, tier, status, expiresAt,
 *            dailyCallLimit, monthlyCallLimit, reason?: string} | null}
 */
export function findApiKey(plaintext) {
  if (!plaintext || typeof plaintext !== "string") return null;
  const statements = stmts();
  if (!statements) return null;

  const row = statements.getByHash.get(hashApiKey(plaintext));
  if (!row) return null;

  const record = toKeyRecord(row);
  if (record.status === "revoked") {
    return { ...record, reason: "revoked" };
  }
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
    return { ...record, reason: "expired" };
  }
  return record;
}

/** Look up a key by its public keyId. */
export function getApiKeyByKeyId(keyId) {
  const statements = stmts();
  if (!statements) return null;
  return toKeyRecord(statements.getByKeyId.get(keyId));
}

/** Mark a key as freshly used. */
export function touchApiKey(id) {
  const statements = stmts();
  if (!statements) return;
  statements.touch.run(id);
}

/** List keys, optionally scoped to one partner. */
export function listApiKeys({ partnerId } = {}) {
  const statements = stmts();
  if (!statements) return [];
  const rows = partnerId ? statements.listByPartner.all(partnerId) : statements.listAll.all();
  return rows.map(toKeyRecord);
}

/** List only keys that are currently usable. */
export function listActiveApiKeys() {
  const statements = stmts();
  if (!statements) return [];
  return statements.listActive.all().map(toKeyRecord);
}

/**
 * Revoke a key. Returns false when the key is unknown or already revoked.
 */
export function revokeApiKey(id) {
  const statements = stmts();
  if (!statements) return false;
  const result = statements.revokeById.run(id);
  if (result.changes === 0) return false;
  countWrite();
  logger.info("Partner API key revoked", { id });
  return true;
}

/**
 * Change a key's tier and/or custom limits.
 * Passing `undefined` for a limit keeps the current value.
 *
 * @returns {object|null} the updated key record, or null when not found
 */
export function updateApiKey(id, { tier, dailyCallLimit, monthlyCallLimit, monthlyPriceCents } = {}) {
  const statements = stmts();
  if (!statements) return null;

  const current = toKeyRecord(statements.getById.get(id));
  if (!current) return null;

  const nextTier = tier === undefined ? current.tier : tier;
  if (!TIERS.includes(nextTier)) throw new Error(`Unknown tier: ${nextTier}`);

  const nextDaily =
    dailyCallLimit === undefined
      ? current.dailyCallLimit
      : dailyCallLimit === null
        ? PRICING_TIERS[nextTier].dailyLimit
        : Number(dailyCallLimit);
  const nextMonthly =
    monthlyCallLimit === undefined
      ? current.monthlyCallLimit
      : monthlyCallLimit === null
        ? PRICING_TIERS[nextTier].monthlyLimit
        : Number(monthlyCallLimit);

  // Enterprise pricing is negotiated, so the base fee is stored per key.
  const nextPrice =
    monthlyPriceCents === undefined || monthlyPriceCents === null
      ? current.monthlyPriceCents
      : Number(monthlyPriceCents);

  statements.updateTier.run(nextTier, nextDaily, nextMonthly, nextPrice, id);
  countWrite();

  return toKeyRecord(statements.getById.get(id));
}

// ─── Metering ─────────────────────────────────────────────────────────────────

/**
 * Persist one metered API call.
 *
 * @param {object} call
 * @param {string} call.keyId
 * @param {string} call.partnerId
 * @param {string} call.endpoint  - e.g. "/api/v1/royalty-split"
 * @param {string} call.method    - HTTP method
 * @param {number} call.statusCode
 * @param {number} [call.durationMs]
 * @param {boolean} [call.rateLimited=false] - true when the call was throttled
 * @returns {boolean} true when the event was stored
 */
export function recordApiCall({
  keyId,
  partnerId,
  endpoint,
  method,
  statusCode,
  durationMs = null,
  rateLimited = false,
} = {}) {
  if (!keyId || !partnerId || !endpoint || !method) return false;
  const statements = stmts();
  if (!statements) return false;

  statements.insertEvent.run(
    keyId,
    partnerId,
    endpoint,
    method,
    Number.isFinite(statusCode) ? statusCode : 0,
    Number.isFinite(durationMs) ? durationMs : null,
    rateLimited ? 1 : 0,
    currentDayStart()
  );
  countWrite();
  return true;
}

/** Delete metered events older than `retentionDays`. */
export function pruneApiCallEvents(retentionDays = DEFAULT_RETENTION_DAYS) {
  const statements = stmts();
  if (!statements) return 0;
  const days = Math.min(Math.max(parseInt(retentionDays, 10) || DEFAULT_RETENTION_DAYS, 1), 3650);
  const result = statements.pruneEvents.run(daysAgo(days));
  if (result.changes > 0) countWrite();
  return result.changes;
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

/**
 * Effective limits for a key — the per-key override when set, otherwise the
 * tier default.
 *
 * @returns {{dailyLimit: number|null, monthlyLimit: number|null}}
 */
export function getEffectiveLimits(key) {
  if (!key) return { dailyLimit: null, monthlyLimit: null };
  return {
    dailyLimit: key.dailyCallLimit ?? PRICING_TIERS[key.tier]?.dailyLimit ?? null,
    monthlyLimit: key.monthlyCallLimit ?? PRICING_TIERS[key.tier]?.monthlyLimit ?? null,
  };
}

/**
 * Current quota consumption for a key, and whether another call is allowed.
 *
 * Throttled calls are not charged against the quota, so a client that is being
 * throttled sees `used` stay flat until the window resets.
 *
 * @param {object} key            - record from findApiKey()
 * @param {object} [options]
 * @param {boolean} [options.skipMetering=false] - do not count this call
 * @returns {{allowed, tier, window, limit, used, remaining, percentUsed, resetsAt}}
 */
export function checkRateLimit(key, { skipMetering = false } = {}) {
  const { dailyLimit, monthlyLimit } = getEffectiveLimits(key);
  const statements = stmts();

  const todayCalls = statements
    ? statements.countDay.get(key.keyId, currentDayStart()).c
    : 0;
  const monthCalls = statements ? statements.countMonth.get(key.keyId, currentMonthStart()).c : 0;

  const base = {
    tier: key.tier,
    dailyLimit,
    monthlyLimit,
    dailyUsed: todayCalls,
    monthlyUsed: monthCalls,
  };

  if (skipMetering) {
    return {
      ...base,
      allowed: true,
      window: null,
      limit: null,
      used: 0,
      remaining: null,
      percentUsed: 0,
      resetsAt: null,
    };
  }

  // Daily quota is checked first — it is the tighter constraint for the free tier.
  if (dailyLimit !== null && todayCalls >= dailyLimit) {
    return {
      ...base,
      allowed: false,
      window: "daily",
      limit: dailyLimit,
      used: todayCalls,
      remaining: 0,
      percentUsed: 100,
      resetsAt: nextUtcMidnight(),
    };
  }

  if (monthlyLimit !== null && monthCalls >= monthlyLimit) {
    return {
      ...base,
      allowed: false,
      window: "monthly",
      limit: monthlyLimit,
      used: monthCalls,
      remaining: 0,
      percentUsed: 100,
      resetsAt: nextUtcMonthStart(),
    };
  }

  // Report the window the partner is closest to exhausting.
  const dailyRemaining = dailyLimit === null ? null : Math.max(dailyLimit - todayCalls, 0);
  const monthlyRemaining = monthlyLimit === null ? null : Math.max(monthlyLimit - monthCalls, 0);
  const useDaily =
    dailyLimit !== null &&
    (monthlyLimit === null || dailyRemaining / dailyLimit <= monthlyRemaining / monthlyLimit);

  const limit = useDaily ? dailyLimit : monthlyLimit;
  const used = useDaily ? todayCalls : monthCalls;
  const remaining = useDaily ? dailyRemaining : monthlyRemaining;
  const percentUsed = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;

  return {
    ...base,
    allowed: true,
    window: useDaily ? "daily" : "monthly",
    limit,
    used,
    remaining,
    percentUsed: Math.round(percentUsed * 10) / 10,
    resetsAt: useDaily ? nextUtcMidnight() : nextUtcMonthStart(),
  };
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

/**
 * Price a partner's usage for one billing month.
 *
 * Base fee comes from the tier (or the negotiated override on the key); calls
 * above the included quota are billed at the tier's overage unit price.
 *
 * @param {object} options
 * @param {string} options.tier
 * @param {number} options.calls                 - billable calls this month
 * @param {number|null} [options.includedCalls]  - quota included in the base fee
 * @param {number} [options.monthlyPriceCents]   - negotiated base fee override
 * @returns {{tier, baseCents, includedCalls, overageCalls, overageUnitPriceCents, overageCents, totalCents, totalUsd}}
 */
export function calculateCharge({
  tier,
  calls = 0,
  includedCalls,
  monthlyPriceCents,
  overageUnitPriceCents,
} = {}) {
  const tierConfig = PRICING_TIERS[tier] ?? PRICING_TIERS.free;
  const baseCents =
    monthlyPriceCents === undefined || monthlyPriceCents === null
      ? tierConfig.monthlyPriceCents
      : Number(monthlyPriceCents);

  const included =
    includedCalls === undefined || includedCalls === null ? tierConfig.monthlyLimit : Number(includedCalls);
  const unitPrice =
    overageUnitPriceCents === undefined || overageUnitPriceCents === null
      ? tierConfig.overageUnitPriceCents
      : Number(overageUnitPriceCents);

  const billable = Math.max(Number(calls) || 0, 0);
  const overageCalls = included === null ? 0 : Math.max(billable - included, 0);
  // A null unit price means overage is not chargeable (free/enterprise).
  const overageCents = unitPrice === null ? 0 : overageCalls * unitPrice;
  const totalCents = baseCents + overageCents;

  return {
    tier: tierConfig.tier,
    baseCents,
    includedCalls: included,
    billableCalls: billable,
    overageCalls,
    overageUnitPriceCents: unitPrice,
    overageCents,
    totalCents,
    totalUsd: Math.round((totalCents / 100) * 100) / 100,
  };
}

/** Public pricing catalogue for the partner-facing endpoints. */
export function getPricingTiers() {
  return TIERS.map((tier) => ({ ...PRICING_TIERS[tier] }));
}

// ─── Analytics ────────────────────────────────────────────────────────────────

/**
 * API calls over time, one bucket per UTC day.
 *
 * Days with no traffic are emitted as zero so the chart has no gaps.
 *
 * @param {object} [options]
 * @param {string} [options.partnerId] - Scope to one partner
 * @param {number} [options.days=30]
 */
export function getUsageOverTime({ partnerId = null, days = 30 } = {}) {
  const window = clampDays(days);
  const since = daysAgo(window - 1);
  const until = currentDayStart();
  const statements = analyticsStmts(Boolean(partnerId));

  const rows = statements ? withPartner(statements.usageOverTime, since, until, partnerId) : [];

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const series = [];
  for (let i = window - 1; i >= 0; i -= 1) {
    const day = daysAgo(i);
    const row = byDay.get(day);
    series.push({
      day,
      calls: row ? row.calls : 0,
      errors: row ? row.errors : 0,
      rateLimited: row ? row.rateLimited : 0,
      avgDurationMs: row ? Math.round(row.avgDurationMs) : 0,
    });
  }

  return { partnerId, days: window, since, until, series };
}

/**
 * The most-used endpoints, ranked by call volume.
 */
export function getTopEndpoints({ partnerId = null, days = 30, limit = 10 } = {}) {
  const window = clampDays(days);
  const since = daysAgo(window - 1);
  const until = currentDayStart();
  const capped = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
  const statements = analyticsStmts(Boolean(partnerId));

  const rows = statements
    ? withPartner(statements.topEndpoints, since, until, partnerId, [capped])
    : [];

  return {
    partnerId,
    days: window,
    endpoints: rows.map((r) => ({
      endpoint: r.endpoint,
      method: r.method,
      calls: r.calls,
      errors: r.errors,
      errorRate: r.calls > 0 ? Math.round((r.errors / r.calls) * 1000) / 10 : 0,
      avgDurationMs: Math.round(r.avgDurationMs),
    })),
  };
}

/**
 * Error-rate breakdown for the window, split by status class.
 */
export function getErrorRates({ partnerId = null, days = 30 } = {}) {
  const window = clampDays(days);
  const since = daysAgo(window - 1);
  const until = currentDayStart();
  const statements = analyticsStmts(Boolean(partnerId));

  const totals = statements
    ? withPartner(statements.totals, since, until, partnerId)[0]
    : null;
  const statusRows = statements ? withPartner(statements.statusBreakdown, since, until, partnerId) : [];

  const totalCalls = totals?.totalCalls ?? 0;
  const totalErrors = totals?.totalErrors ?? 0;
  const serverErrors = totals?.serverErrors ?? 0;
  const clientErrors = Math.max(totalErrors - serverErrors, 0);

  return {
    partnerId,
    days: window,
    totalCalls,
    totalErrors,
    serverErrors,
    clientErrors,
    rateLimited: totals?.totalRateLimited ?? 0,
    errorRate: totalCalls > 0 ? Math.round((totalErrors / totalCalls) * 1000) / 10 : 0,
    avgDurationMs: Math.round(totals?.avgDurationMs ?? 0),
    byStatusCode: statusRows.map((r) => ({
      statusCode: r.statusCode,
      calls: r.calls,
      errorRate:
        totalCalls > 0 ? Math.round((r.calls / totalCalls) * 1000) / 10 : 0,
    })),
  };
}

/**
 * Revenue attributed to each partner for the window, using the tier pricing
 * model. Throttled calls are never billable.
 */
export function getRevenueByPartner({ days = 30 } = {}) {
  const window = clampDays(days);
  const since = daysAgo(window - 1);
  const until = currentDayStart();
  const statements = stmts();

  const rows = statements ? statements.partnerTotals.all(since, until) : [];

  // A partner can hold several keys; roll them up per partner + tier.
  const byPartner = new Map();
  for (const row of rows) {
    const id = row.partnerId;
    if (!byPartner.has(id)) {
      byPartner.set(id, {
        partnerId: id,
        partnerName: row.partnerName,
        tiers: new Set(),
        keys: 0,
        activeKeys: 0,
        calls: 0,
        errors: 0,
        baseCents: 0,
        includedCalls: 0,
        negotiatedCents: null,
      });
    }
    const entry = byPartner.get(id);
    entry.tiers.add(row.tier);
    entry.keys += 1;
    if (row.status === "active") entry.activeKeys += 1;
    entry.calls += row.calls ?? 0;
    entry.errors += row.errors ?? 0;
    entry.baseCents += row.monthlyPriceCents ?? 0;
    entry.includedCalls += row.monthlyCallLimit ?? 0;
    // Enterprise keys carry a negotiated monthly fee; surface it separately
    // so the dashboard can label it as such.
    if (row.tier === "enterprise" && (row.monthlyPriceCents ?? 0) > 0) {
      entry.negotiatedCents = (entry.negotiatedCents ?? 0) + row.monthlyPriceCents;
    }
  }

  const partners = [...byPartner.values()].map((entry) => {
    const tier = entry.tiers.size === 1 ? [...entry.tiers][0] : "enterprise";
    const charge = calculateCharge({
      tier,
      calls: entry.calls,
      includedCalls: entry.includedCalls || undefined,
      monthlyPriceCents: entry.baseCents,
    });
    return {
      partnerId: entry.partnerId,
      partnerName: entry.partnerName,
      tier,
      keys: entry.keys,
      activeKeys: entry.activeKeys,
      calls: entry.calls,
      errors: entry.errors,
      errorRate: entry.calls > 0 ? Math.round((entry.errors / entry.calls) * 1000) / 10 : 0,
      negotiated: entry.negotiatedCents !== null,
      ...charge,
    };
  });

  partners.sort((a, b) => b.totalCents - a.totalCents || b.calls - a.calls);

  return {
    days: window,
    partners,
    totals: {
      partners: partners.length,
      calls: partners.reduce((sum, p) => sum + p.calls, 0),
      baseCents: partners.reduce((sum, p) => sum + p.baseCents, 0),
      overageCents: partners.reduce((sum, p) => sum + p.overageCents, 0),
      totalCents: partners.reduce((sum, p) => sum + p.totalCents, 0),
      totalUsd: Math.round((partners.reduce((sum, p) => sum + p.totalCents, 0) / 100) * 100) / 100,
    },
  };
}

/**
 * Headline counters for the partner analytics dashboard.
 */
export function getPartnerOverview({ days = 30 } = {}) {
  const window = clampDays(days);
  const keys = listApiKeys();
  const errors = getErrorRates({ days: window });
  const revenue = getRevenueByPartner({ days: window });

  const activeKeys = keys.filter((k) => k.status === "active");
  const byTier = {};
  for (const tier of TIERS) {
    byTier[tier] = activeKeys.filter((k) => k.tier === tier).length;
  }

  return {
    days: window,
    totalKeys: keys.length,
    activeKeys: activeKeys.length,
    revokedKeys: keys.length - activeKeys.length,
    partners: new Set(keys.map((k) => k.partnerId)).size,
    keysByTier: byTier,
    totalCalls: errors.totalCalls,
    errorRate: errors.errorRate,
    rateLimited: errors.rateLimited,
    avgDurationMs: errors.avgDurationMs,
    mrrCents: revenue.totals.totalCents,
    mrrUsd: revenue.totals.totalUsd,
  };
}

/**
 * Everything the partner analytics dashboard needs, in one payload.
 */
export function getAnalyticsDashboard({ partnerId = null, days = 30 } = {}) {
  return {
    overview: getPartnerOverview({ days }),
    usageOverTime: getUsageOverTime({ partnerId, days }),
    topEndpoints: getTopEndpoints({ partnerId, days }),
    errorRates: getErrorRates({ partnerId, days }),
    revenue: partnerId
      ? {
          ...getRevenueByPartner({ days }),
          partners: getRevenueByPartner({ days }).partners.filter(
            (p) => p.partnerId === partnerId
          ),
        }
      : getRevenueByPartner({ days }),
    tiers: getPricingTiers(),
  };
}
