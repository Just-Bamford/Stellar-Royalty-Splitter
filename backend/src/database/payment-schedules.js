/**
 * Payment schedule templates — closes #599.
 *
 * Admins create reusable schedule templates that are applied to contracts.
 * A background scheduler checks which schedules are due and auto-triggers
 * distribution requests.
 *
 * Schedule types:
 *   monthly  — runs on a specific day-of-month (1–28) at a given UTC hour
 *   biweekly — runs every 14 days from the anchor date at a given UTC hour
 *   weekly   — runs on a specific day-of-week (0=Sun…6=Sat) at a given UTC hour
 *   custom   — runs on a cron-like intervalDays cadence from anchor date
 */

import { db, countWrite } from "./core.js";

export const SCHEDULE_TYPES = /** @type {const} */ (["monthly", "biweekly", "weekly", "custom"]);

// ─── Schema helpers ──────────────────────────────────────────────────────────

function parseScheduleRow(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: row.enabled === 1,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

// ─── Schedule CRUD ───────────────────────────────────────────────────────────

/**
 * Create a new payment schedule template.
 *
 * @param {object} params
 * @param {string} params.name          - Human-readable name
 * @param {string} params.type          - One of SCHEDULE_TYPES
 * @param {string} params.contractId    - Contract this schedule applies to
 * @param {string} params.tokenId       - Token to distribute
 * @param {string} params.walletAddress - Initiator wallet for the distribution
 * @param {number} params.dayOfMonth    - (monthly) 1–28
 * @param {number} params.dayOfWeek     - (weekly)  0–6
 * @param {number} params.intervalDays  - (biweekly=14, custom=N)
 * @param {string} params.anchorDate    - ISO date string; first run date used as epoch for interval calc
 * @param {number} params.hourOfDay     - UTC hour (0–23) to trigger
 * @param {string} params.timezone      - IANA timezone name (stored; client display only — scheduling is UTC)
 * @param {object|null} params.metadata - Arbitrary JSON metadata
 * @returns {object} Created schedule row
 */
export function createPaymentSchedule({
  name,
  type,
  contractId,
  tokenId,
  walletAddress,
  dayOfMonth = null,
  dayOfWeek = null,
  intervalDays = null,
  anchorDate = null,
  hourOfDay = 0,
  timezone = "UTC",
  metadata = null,
}) {
  const result = db.prepare(`
    INSERT INTO payment_schedules
      (name, type, contractId, tokenId, walletAddress,
       dayOfMonth, dayOfWeek, intervalDays, anchorDate,
       hourOfDay, timezone, enabled, metadata, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    name, type, contractId, tokenId, walletAddress,
    dayOfMonth, dayOfWeek, intervalDays, anchorDate,
    hourOfDay, timezone,
    metadata ? JSON.stringify(metadata) : null
  );

  countWrite();
  return getPaymentSchedule(result.lastInsertRowid);
}

/**
 * Retrieve a schedule by ID.
 *
 * @param {number} id
 * @returns {object|null}
 */
export function getPaymentSchedule(id) {
  return parseScheduleRow(
    db.prepare(`
      SELECT id, name, type, contractId, tokenId, walletAddress,
             dayOfMonth, dayOfWeek, intervalDays, anchorDate,
             hourOfDay, timezone, enabled, lastRunAt, nextRunAt, metadata,
             createdAt, updatedAt
      FROM payment_schedules WHERE id = ?
    `).get(id)
  );
}

/**
 * List all schedule templates, optionally filtered by contract.
 *
 * @param {string|null} contractId
 * @param {{ includeDisabled?: boolean, limit?: number, offset?: number }} opts
 * @returns {object[]}
 */
export function listPaymentSchedules(contractId = null, { includeDisabled = false, limit = 50, offset = 0 } = {}) {
  let sql = `
    SELECT id, name, type, contractId, tokenId, walletAddress,
           dayOfMonth, dayOfWeek, intervalDays, anchorDate,
           hourOfDay, timezone, enabled, lastRunAt, nextRunAt, metadata,
           createdAt, updatedAt
    FROM payment_schedules WHERE 1=1
  `;
  const params = [];

  if (contractId) {
    sql += " AND contractId = ?";
    params.push(contractId);
  }

  if (!includeDisabled) {
    sql += " AND enabled = 1";
  }

  sql += " ORDER BY contractId, name LIMIT ? OFFSET ?";
  params.push(limit, offset);

  return db.prepare(sql).all(...params).map(parseScheduleRow);
}

/**
 * Count schedule templates for a contract.
 */
export function countPaymentSchedules(contractId = null, { includeDisabled = false } = {}) {
  let sql = "SELECT COUNT(*) as total FROM payment_schedules WHERE 1=1";
  const params = [];
  if (contractId) { sql += " AND contractId = ?"; params.push(contractId); }
  if (!includeDisabled) { sql += " AND enabled = 1"; }
  return db.prepare(sql).get(...params)?.total ?? 0;
}

/**
 * Update a payment schedule.
 *
 * @param {number} id
 * @param {Partial<object>} updates - Fields to update
 * @returns {object|null}
 */
export function updatePaymentSchedule(id, updates) {
  const allowed = [
    "name", "dayOfMonth", "dayOfWeek", "intervalDays", "anchorDate",
    "hourOfDay", "timezone", "enabled", "nextRunAt", "metadata",
  ];
  const fields = Object.keys(updates).filter((k) => allowed.includes(k));
  if (fields.length === 0) return getPaymentSchedule(id);

  const setClauses = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => {
    if (f === "metadata") return updates[f] ? JSON.stringify(updates[f]) : null;
    if (f === "enabled") return updates[f] ? 1 : 0;
    return updates[f] ?? null;
  });

  db.prepare(`
    UPDATE payment_schedules
    SET ${setClauses}, updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(...values, id);

  countWrite();
  return getPaymentSchedule(id);
}

/**
 * Disable a schedule (soft delete).
 *
 * @param {number} id
 */
export function disablePaymentSchedule(id) {
  db.prepare("UPDATE payment_schedules SET enabled = 0, updatedAt = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  countWrite();
}

/**
 * Permanently delete a schedule.
 *
 * @param {number} id
 */
export function deletePaymentSchedule(id) {
  db.prepare("DELETE FROM payment_schedules WHERE id = ?").run(id);
  countWrite();
}

// ─── Scheduler helpers ────────────────────────────────────────────────────────

/**
 * Return all enabled schedules whose nextRunAt is at or before `now`.
 *
 * @param {string} nowIso - ISO datetime string
 * @returns {object[]}
 */
export function getSchedulesDue(nowIso) {
  return db.prepare(`
    SELECT id, name, type, contractId, tokenId, walletAddress,
           dayOfMonth, dayOfWeek, intervalDays, anchorDate,
           hourOfDay, timezone, enabled, lastRunAt, nextRunAt, metadata,
           createdAt, updatedAt
    FROM payment_schedules
    WHERE enabled = 1
      AND nextRunAt IS NOT NULL
      AND nextRunAt <= ?
    ORDER BY nextRunAt ASC
  `).all(nowIso).map(parseScheduleRow);
}

/**
 * Mark a schedule as just-run and compute the next run time.
 *
 * @param {number} id
 * @param {string} ranAt   - ISO datetime the run was triggered
 * @param {string} nextAt  - ISO datetime for the next scheduled run
 */
export function markScheduleRan(id, ranAt, nextAt) {
  db.prepare(`
    UPDATE payment_schedules
    SET lastRunAt = ?, nextRunAt = ?, updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(ranAt, nextAt, id);
  countWrite();
}

/**
 * Set the initial nextRunAt when a schedule is created or activated.
 *
 * @param {number} id
 * @param {string} nextAt - ISO datetime
 */
export function setNextRunAt(id, nextAt) {
  db.prepare(`
    UPDATE payment_schedules SET nextRunAt = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?
  `).run(nextAt, id);
  countWrite();
}

// ─── Upcoming schedule listing ────────────────────────────────────────────────

/**
 * Return the next N upcoming scheduled runs across all enabled schedules
 * for a given contract (or globally if contractId is null).
 *
 * @param {string|null} contractId
 * @param {number} limit
 * @returns {object[]}
 */
export function getUpcomingSchedules(contractId = null, limit = 10) {
  let sql = `
    SELECT id, name, type, contractId, tokenId, walletAddress,
           hourOfDay, timezone, nextRunAt, lastRunAt
    FROM payment_schedules
    WHERE enabled = 1 AND nextRunAt IS NOT NULL
  `;
  const params = [];
  if (contractId) { sql += " AND contractId = ?"; params.push(contractId); }
  sql += " ORDER BY nextRunAt ASC LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params);
}
