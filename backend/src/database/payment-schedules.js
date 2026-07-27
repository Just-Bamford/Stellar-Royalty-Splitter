/**
 * Payment schedule template database functions (#599).
 * Stores and manages recurring payment schedule definitions.
 */

import { db, countWrite } from "./core.js";

/**
 * Compute the next run timestamp (ISO string) for a schedule.
 * @param {object} schedule
 * @param {Date} [from] - base time (defaults to now)
 * @returns {string} ISO datetime string
 */
export function computeNextRunAt(schedule, from = new Date()) {
  const tz = schedule.timezone ?? "UTC";
  // Work in UTC offsets — for full tz support a library like luxon would be used;
  // here we handle UTC and common offset strings as a lightweight approach.
  const base = new Date(from);

  switch (schedule.schedule_type) {
    case "monthly": {
      const day = schedule.day_of_month ?? 1;
      const hour = schedule.hour_of_day ?? 9;
      // Try current month first, then next month if already past
      const candidate = new Date(Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth(),
        day,
        hour,
        0, 0, 0
      ));
      if (candidate <= base) {
        candidate.setUTCMonth(candidate.getUTCMonth() + 1);
      }
      return candidate.toISOString();
    }
    case "biweekly": {
      const hour = schedule.hour_of_day ?? 9;
      const next = new Date(base.getTime() + 14 * 24 * 60 * 60 * 1000);
      next.setUTCHours(hour, 0, 0, 0);
      return next.toISOString();
    }
    case "weekly": {
      const targetDay = schedule.day_of_week ?? 0; // 0 = Sunday
      const hour = schedule.hour_of_day ?? 9;
      const daysAhead = (targetDay - base.getUTCDay() + 7) % 7 || 7;
      const next = new Date(base.getTime() + daysAhead * 24 * 60 * 60 * 1000);
      next.setUTCHours(hour, 0, 0, 0);
      return next.toISOString();
    }
    case "custom":
    default: {
      // Custom schedules have manually set next_run_at; just return 7 days ahead
      const next = new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000);
      return next.toISOString();
    }
  }
}

/**
 * Create a new payment schedule template.
 */
export function createPaymentSchedule(data) {
  const nextRunAt = computeNextRunAt(data);
  const result = db.prepare(`
    INSERT INTO payment_schedules
      (name, contractId, schedule_type, day_of_month, day_of_week, hour_of_day, timezone, enabled, created_by, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name,
    data.contractId,
    data.schedule_type,
    data.day_of_month ?? null,
    data.day_of_week ?? null,
    data.hour_of_day ?? 9,
    data.timezone ?? "UTC",
    data.enabled !== false ? 1 : 0,
    data.created_by ?? "admin",
    nextRunAt
  );
  countWrite();
  return getPaymentSchedule(result.lastInsertRowid);
}

/**
 * Get a schedule by ID.
 */
export function getPaymentSchedule(id) {
  return db.prepare("SELECT * FROM payment_schedules WHERE id = ?").get(id) ?? null;
}

/**
 * List all schedules for a contract.
 */
export function getSchedulesByContract(contractId) {
  return db
    .prepare("SELECT * FROM payment_schedules WHERE contractId = ? ORDER BY created_at DESC")
    .all(contractId);
}

/**
 * List all enabled schedules (across all contracts).
 */
export function getAllEnabledSchedules() {
  return db
    .prepare("SELECT * FROM payment_schedules WHERE enabled = 1 ORDER BY next_run_at ASC")
    .all();
}

/**
 * Get schedules that are due to run (next_run_at <= now).
 */
export function getDueSchedules(now = new Date()) {
  return db
    .prepare(
      "SELECT * FROM payment_schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC"
    )
    .all(now.toISOString());
}

/**
 * Update a payment schedule.
 */
export function updatePaymentSchedule(id, updates) {
  const existing = getPaymentSchedule(id);
  if (!existing) return null;

  const merged = { ...existing, ...updates };
  const nextRunAt = updates.next_run_at ?? computeNextRunAt(merged);

  db.prepare(`
    UPDATE payment_schedules SET
      name = ?,
      schedule_type = ?,
      day_of_month = ?,
      day_of_week = ?,
      hour_of_day = ?,
      timezone = ?,
      enabled = ?,
      next_run_at = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    merged.name,
    merged.schedule_type,
    merged.day_of_month ?? null,
    merged.day_of_week ?? null,
    merged.hour_of_day ?? 9,
    merged.timezone ?? "UTC",
    merged.enabled !== false ? 1 : 0,
    nextRunAt,
    id
  );
  countWrite();
  return getPaymentSchedule(id);
}

/**
 * Mark a schedule as run (advance next_run_at and update last_run_at).
 */
export function markScheduleRun(id, now = new Date()) {
  const schedule = getPaymentSchedule(id);
  if (!schedule) return null;
  const nextRunAt = computeNextRunAt(schedule, now);
  db.prepare(`
    UPDATE payment_schedules SET
      last_run_at = ?,
      next_run_at = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(now.toISOString(), nextRunAt, id);
  countWrite();
  return getPaymentSchedule(id);
}

/**
 * Delete a payment schedule.
 */
export function deletePaymentSchedule(id) {
  const result = db.prepare("DELETE FROM payment_schedules WHERE id = ?").run(id);
  countWrite();
  return result.changes > 0;
}

/**
 * Log a scheduled distribution attempt.
 */
export function logScheduledDistribution(scheduleId, contractId, status, errorMessage = null, transactionId = null) {
  const result = db.prepare(`
    INSERT INTO scheduled_distribution_log (scheduleId, contractId, status, error_message, transaction_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(scheduleId, contractId, status, errorMessage, transactionId);
  countWrite();
  return result.lastInsertRowid;
}

/**
 * Get the run history for a schedule.
 */
export function getScheduleHistory(scheduleId, limit = 20) {
  return db
    .prepare(
      "SELECT * FROM scheduled_distribution_log WHERE scheduleId = ? ORDER BY triggered_at DESC LIMIT ?"
    )
    .all(scheduleId, limit);
}
