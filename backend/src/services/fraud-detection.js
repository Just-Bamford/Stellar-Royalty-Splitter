/**
 * Fraud detection and anomaly-scoring service (#1042).
 *
 * Records per-user behavioural baselines, scores incoming transactions against
 * the pure anomaly engine (`anomaly-scorer.js`), and raises / resolves fraud
 * alerts through a verification flow (email / 2FA token). Persisted via
 * better-sqlite3 (`db` from `database/core.js`).
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { db } from "../database/core.js";
import logger from "../logger.js";
import {
  scoreTransaction,
  deriveAlertLevel,
  DEFAULT_THRESHOLDS,
} from "./anomaly-scorer.js";

export const VERIFICATION_THRESHOLD = DEFAULT_THRESHOLDS.verification;
export const BLOCK_THRESHOLD = DEFAULT_THRESHOLDS.block;

const VERIFICATION_WINDOW_MIN = 30;
const TOKEN_BYTES = 32;
const EMA_ALPHA = 0.2;

function now() {
  return Math.floor(Date.now() / 1000);
}

/* -------------------------------------------------------------------------- */
/* Schema                                                                     */
/* -------------------------------------------------------------------------- */

function initializeDatabase() {
  const sql = `
    CREATE TABLE IF NOT EXISTS fraud_baselines (
      userId TEXT PRIMARY KEY,
      avgAmount REAL NOT NULL DEFAULT 0,
      locationsJson TEXT NOT NULL DEFAULT '[]',
      devicesJson TEXT NOT NULL DEFAULT '[]',
      usualHoursStart INTEGER NOT NULL DEFAULT 0,
      usualHoursEnd INTEGER NOT NULL DEFAULT 23,
      sampleCount INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fraud_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      transactionId TEXT,
      score INTEGER NOT NULL,
      factorsJson TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fraud_scores_user ON fraud_scores(userId, createdAt DESC);
    CREATE TABLE IF NOT EXISTS fraud_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      transactionId TEXT,
      score INTEGER NOT NULL,
      level TEXT NOT NULL,
      factorsJson TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      createdAt INTEGER NOT NULL,
      resolvedAt INTEGER,
      resolution TEXT,
      adminNotified INTEGER NOT NULL DEFAULT 0,
      userNotified INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_fraud_alerts_user ON fraud_alerts(userId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_fraud_alerts_status ON fraud_alerts(status, createdAt DESC);
    CREATE TABLE IF NOT EXISTS fraud_verification_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      alertId INTEGER NOT NULL,
      tokenHash TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fraud_tokens_alert ON fraud_verification_tokens(alertId);
  `;

  try {
    db.exec(sql);
  } catch (err) {
    logger.error("Failed to initialise fraud detection tables", { error: err.message });
    throw err;
  }
}

initializeDatabase();

/* -------------------------------------------------------------------------- */
/* Behavioural baseline                                                       */
/* -------------------------------------------------------------------------- */

export function getBaseline(userId) {
  return db.prepare(`SELECT * FROM fraud_baselines WHERE userId = ?`).get(userId) ?? null;
}

/**
 * Update a user's behavioural baseline incrementally.
 * Amount uses an exponential moving average; locations/devices accumulate;
 * usual hours expand to the observed [min, max] hour.
 */
export function updateBaseline(userId, event = {}) {
  const { amount, location, device, hour } = event;
  const existing = getBaseline(userId);

  const prevAvg = existing ? Number(existing.avgAmount) : 0;
  const prevCount = existing ? existing.sampleCount : 0;
  const nextAmount = Number(amount) || 0;
  const avgAmount = prevCount === 0 ? nextAmount : prevAvg + EMA_ALPHA * (nextAmount - prevAvg);

  const locations = existing ? JSON.parse(existing.locationsJson || "[]") : [];
  const devices = existing ? JSON.parse(existing.devicesJson || "[]") : [];
  if (location && !locations.includes(location)) locations.push(location);
  if (device && !devices.includes(device)) devices.push(device);

  let startH = existing ? existing.usualHoursStart : 0;
  let endH = existing ? existing.usualHoursEnd : 23;
  if (hour != null) {
    const h = Number(hour);
    if (Number.isFinite(h)) {
      if (prevCount === 0) {
        startH = h;
        endH = h;
      } else {
        startH = Math.min(startH, h);
        endH = Math.max(endH, h);
      }
    }
  }

  db.prepare(
    `INSERT INTO fraud_baselines
       (userId, avgAmount, locationsJson, devicesJson, usualHoursStart, usualHoursEnd, sampleCount, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(userId) DO UPDATE SET
       avgAmount = excluded.avgAmount,
       locationsJson = excluded.locationsJson,
       devicesJson = excluded.devicesJson,
       usualHoursStart = excluded.usualHoursStart,
       usualHoursEnd = excluded.usualHoursEnd,
       sampleCount = excluded.sampleCount,
       updatedAt = excluded.updatedAt`,
  ).run(
    userId,
    avgAmount,
    JSON.stringify(locations),
    JSON.stringify(devices),
    startH,
    endH,
    prevCount + 1,
    now(),
  );

  return getBaseline(userId);
}

/* -------------------------------------------------------------------------- */
/* Scoring + alerting                                                         */
/* -------------------------------------------------------------------------- */

function createAlert({ userId, transactionId, score, factors, level }) {
  const isBlock = level === "block";
  const result = db.prepare(
    `INSERT INTO fraud_alerts
       (userId, transactionId, score, level, factorsJson, status, createdAt, adminNotified, userNotified)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
  ).run(
    userId,
    transactionId || null,
    score,
    level,
    JSON.stringify(factors),
    now(),
    isBlock ? 1 : 0,
    1,
  );

  const alert = db.prepare(`SELECT * FROM fraud_alerts WHERE id = ?`).get(result.lastID);
  logger[isBlock ? "warn" : "info"]("Fraud alert raised", {
    userId,
    alertId: result.lastID,
    level,
    score,
  });
  return alert;
}

/**
 * Score a transaction event end-to-end.
 * Computes the risk score, persists it, and raises an alert (+ verification
 * token / admin notification) when the level is not "allow".
 *
 * @returns {{ score: number, factors: object[], level: string, alertId: number|null }}
 */
export function scoreTransactionEvent(event) {
  const { userId, transactionId, amount, location, hour, failedAttempts } = event;

  const baseline =
    getBaseline(userId) || {
      avgAmount: 0,
      locationsJson: "[]",
      devicesJson: "[]",
      usualHoursStart: 0,
      usualHoursEnd: 23,
    };

  const locations = baseline.locationsJson ? JSON.parse(baseline.locationsJson) : [];
  const isNewLocation = !!(location && !locations.includes(location));
  const usualHours = { start: baseline.usualHoursStart, end: baseline.usualHoursEnd };

  const { score, factors } = scoreTransaction({
    amount,
    historicalAverage: baseline.avgAmount,
    isNewLocation,
    failedAttempts,
    hour,
    usualHours,
  });

  db.prepare(
    `INSERT INTO fraud_scores (userId, transactionId, score, factorsJson, createdAt)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, transactionId || null, score, JSON.stringify(factors), now());

  const level = deriveAlertLevel(score);
  let alertId = null;

  if (level !== "allow") {
    const alert = createAlert({ userId, transactionId, score, factors, level });
    alertId = alert.id;
    if (level === "require_verification") {
      createVerificationToken(alert.id);
    }
  }

  return { score, factors, level, alertId };
}

/* -------------------------------------------------------------------------- */

export function getAlerts({ userId, status = "open", limit = 50 } = {}) {
  const params = [];
  let query = `SELECT * FROM fraud_alerts WHERE 1=1`;
  if (userId) {
    query += ` AND userId = ?`;
    params.push(userId);
  }
  if (status && status !== "all") {
    query += ` AND status = ?`;
    params.push(status);
  }
  query += ` ORDER BY createdAt DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(query).all(...params);
}

export function getAlert(id) {
  return db.prepare(`SELECT * FROM fraud_alerts WHERE id = ?`).get(id) ?? null;
}

export function resolveAlert(id, { action, resolvedBy, resolution }) {
  if (!id) throw new Error("alert id is required");
  if (!["approve", "block"].includes(action)) {
    throw new Error(`invalid resolution action: ${action}`);
  }
  const current = getAlert(id);
  if (!current) return null;

  const nowSec = now();
  db.prepare(
    `UPDATE fraud_alerts
     SET status = 'resolved',
         resolution = ?,
         resolvedAt = ?
     WHERE id = ?`,
  ).run(resolution || action, nowSec, id);

  logger.info("Fraud alert resolved", { alertId: id, action, resolvedBy });
  return {
    ...current,
    status: "resolved",
    resolution: resolution || action,
    resolvedAt: nowSec,
  };
}

/* -------------------------------------------------------------------------- */
/* Verification flow (email / 2FA)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Issue an opaque verification token for an open alert. The raw token is
 * returned (for email/SMS dispatch) but only its hash is persisted.
 */
export function createVerificationToken(alertId) {
  const alert = getAlert(alertId);
  if (!alert) throw new Error(`alert not found: ${alertId}`);

  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = now() + VERIFICATION_WINDOW_MIN * 60;

  db.prepare(
    `INSERT INTO fraud_verification_tokens
       (userId, alertId, tokenHash, expiresAt, createdAt)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(alert.userId, Number(alertId), tokenHash, expiresAt, now());

  logger.info("Fraud verification token issued", { userId: alert.userId, alertId });
  return token;
}

/**
 * Validate a user-supplied token against the alert's outstanding token.
 * On success the alert is resolved as "approved" and the token is consumed.
 */
export function verifyToken(alertId, token) {
  if (!alertId || !token) {
    return { valid: false, reason: "missing_token" };
  }
  if (!getAlert(alertId)) {
    return { valid: false, reason: "alert_not_found" };
  }

  const providedHash = createHash("sha256").update(token).digest("hex");
  const row = db
    .prepare(
      `SELECT * FROM fraud_verification_tokens
       WHERE alertId = ? AND used = 0 AND expiresAt > ?
       ORDER BY createdAt DESC LIMIT 1`,
    )
    .get(Number(alertId), now());

  if (!row) {
    return { valid: false, reason: "invalid_or_expired_token" };
  }

  let match = false;
  try {
    match =
      Buffer.from(row.tokenHash, "hex").length === 32 &&
      timingSafeEqual(Buffer.from(row.tokenHash, "hex"), Buffer.from(providedHash, "hex"));
  } catch {
    match = false;
  }

  if (!match) {
    return { valid: false, reason: "invalid_or_expired_token" };
  }

  db.prepare(`UPDATE fraud_verification_tokens SET used = 1 WHERE id = ?`).run(row.id);
  resolveAlert(Number(alertId), {
    action: "approve",
    resolvedBy: `user:${getAlert(alertId).userId}`,
    resolution: "verified",
  });

  logger.info("Fraud verification succeeded", { alertId });
  return { valid: true, alertId: Number(alertId) };
}

export default {
  VERIFICATION_THRESHOLD,
  BLOCK_THRESHOLD,
  getBaseline,
  updateBaseline,
  scoreTransactionEvent,
  getAlerts,
  getAlert,
  resolveAlert,
  createVerificationToken,
  verifyToken,
  scoreTransaction,
  deriveAlertLevel,
};
