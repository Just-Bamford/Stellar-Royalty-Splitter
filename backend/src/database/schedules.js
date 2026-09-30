/**
 * Database functions for distribution schedules and batch execution tracking.
 *
 * Distribution schedules define a recurring time-based rule for executing
 * distributions automatically. Each schedule run produces a batch_execution
 * record, and each item within that batch produces a batch_execution_items row.
 *
 * Frequencies:
 *   weekly   - runs once per week on a given dayOfWeek
 *   biweekly - runs every two weeks on a given dayOfWeek
 *   monthly  - runs once per month on a given dayOfMonth (capped at 28 to be
 *              safe across all calendar months)
 */

import { db, countWrite } from "./core.js";

// ── Schedule CRUD ──────────────────────────────────────────────────────────────

/**
 * Create a new distribution schedule and return the new row ID.
 *
 * @param {object} params
 * @param {string} params.contractId
 * @param {string} params.walletAddress
 * @param {string} params.tokenId
 * @param {string} params.frequency   - 'weekly' | 'biweekly' | 'monthly'
 * @param {number|null} params.dayOfWeek   - 0–6, required for weekly/biweekly
 * @param {number|null} params.dayOfMonth  - 1–28, required for monthly
 * @param {number} params.hourOfDay   - 0–23
 * @param {number} params.minuteOfHour - 0–59
 * @param {string|null} params.nextRunAt  - ISO 8601 datetime or null
 * @returns {number} The new schedule ID
 */
export function createSchedule({
  contractId,
  walletAddress,
  tokenId,
  frequency,
  dayOfWeek = null,
  dayOfMonth = null,
  hourOfDay = 0,
  minuteOfHour = 0,
  nextRunAt = null,
}) {
  const stmt = db.prepare(`
    INSERT INTO distribution_schedules
      (contractId, walletAddress, tokenId, frequency,
       dayOfWeek, dayOfMonth, hourOfDay, minuteOfHour,
       enabled, nextRunAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);

  const result = stmt.run(
    contractId,
    walletAddress,
    tokenId,
    frequency,
    dayOfWeek,
    dayOfMonth,
    hourOfDay,
    minuteOfHour,
    nextRunAt
  );
  countWrite();
  return result.lastInsertRowid;
}

/**
 * Get a single schedule by ID. Returns null if not found.
 *
 * @param {number} scheduleId
 * @returns {object|null}
 */
export function getScheduleById(scheduleId) {
  return (
    db
      .prepare(
        `SELECT * FROM distribution_schedules WHERE id = ?`
      )
      .get(scheduleId) ?? null
  );
}

/**
 * List all schedules for a contract, newest first.
 *
 * @param {string} contractId
 * @param {number} limit
 * @param {number} offset
 * @returns {object[]}
 */
export function listSchedulesByContract(contractId, limit = 50, offset = 0) {
  return db
    .prepare(
      `SELECT * FROM distribution_schedules
       WHERE contractId = ?
       ORDER BY createdAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(contractId, limit, offset);
}

/**
 * Count all schedules for a contract.
 *
 * @param {string} contractId
 * @returns {number}
 */
export function countSchedulesByContract(contractId) {
  return db
    .prepare(
      `SELECT COUNT(*) as total FROM distribution_schedules WHERE contractId = ?`
    )
    .get(contractId).total;
}

/**
 * Update mutable fields on a schedule.
 * Only the fields provided in `updates` are changed; pass only what changed.
 *
 * @param {number} scheduleId
 * @param {object} updates  - subset of: frequency, dayOfWeek, dayOfMonth,
 *                            hourOfDay, minuteOfHour, enabled, nextRunAt
 * @returns {boolean} true if a row was updated
 */
export function updateSchedule(scheduleId, updates) {
  const allowed = [
    "frequency",
    "dayOfWeek",
    "dayOfMonth",
    "hourOfDay",
    "minuteOfHour",
    "enabled",
    "nextRunAt",
  ];

  const setClauses = [];
  const values = [];

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      setClauses.push(`${key} = ?`);
      values.push(updates[key]);
    }
  }

  if (setClauses.length === 0) return false;

  // Always bump updatedAt
  setClauses.push("updatedAt = CURRENT_TIMESTAMP");
  values.push(scheduleId);

  const result = db
    .prepare(
      `UPDATE distribution_schedules SET ${setClauses.join(", ")} WHERE id = ?`
    )
    .run(...values);
  countWrite();
  return result.changes > 0;
}

/**
 * Delete a schedule by ID. Cascades to batch_executions via ON DELETE SET NULL
 * (batch records are preserved for history, scheduleId becomes null).
 *
 * @param {number} scheduleId
 * @returns {boolean} true if a row was deleted
 */
export function deleteSchedule(scheduleId) {
  const result = db
    .prepare(`DELETE FROM distribution_schedules WHERE id = ?`)
    .run(scheduleId);
  countWrite();
  return result.changes > 0;
}

/**
 * Mark a schedule as paused (enabled = 0).
 *
 * @param {number} scheduleId
 * @returns {boolean}
 */
export function pauseSchedule(scheduleId) {
  return updateSchedule(scheduleId, { enabled: 0 });
}

/**
 * Mark a schedule as active (enabled = 1).
 *
 * @param {number} scheduleId
 * @returns {boolean}
 */
export function resumeSchedule(scheduleId) {
  return updateSchedule(scheduleId, { enabled: 1 });
}

/**
 * Update nextRunAt, lastRunAt, and lastRunStatus after a run completes.
 *
 * @param {number} scheduleId
 * @param {string} nextRunAt  - ISO datetime for the next scheduled run
 * @param {string} lastRunStatus - 'success' | 'failed' | 'partial'
 */
export function markScheduleRun(scheduleId, nextRunAt, lastRunStatus) {
  db.prepare(`
    UPDATE distribution_schedules
    SET lastRunAt = CURRENT_TIMESTAMP,
        lastRunStatus = ?,
        nextRunAt = ?,
        updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(lastRunStatus, nextRunAt, scheduleId);
  countWrite();
}

/**
 * Return all enabled schedules whose nextRunAt is in the past (due to run).
 * Used by the scheduler job on each tick.
 *
 * @param {Date} [now]
 * @returns {object[]}
 */
export function getDueSchedules(now = new Date()) {
  const nowIso = now.toISOString();
  return db
    .prepare(
      `SELECT * FROM distribution_schedules
       WHERE enabled = 1
         AND nextRunAt IS NOT NULL
         AND nextRunAt <= ?
       ORDER BY nextRunAt ASC`
    )
    .all(nowIso);
}

// ── Batch execution CRUD ───────────────────────────────────────────────────────

/**
 * Create a new batch execution record (status = 'pending').
 * Returns the new batch execution ID.
 *
 * @param {number|null} scheduleId  - null for ad-hoc batches
 * @param {number} totalItems
 * @returns {number}
 */
export function createBatchExecution(scheduleId, totalItems) {
  const result = db
    .prepare(
      `INSERT INTO batch_executions (scheduleId, status, totalItems)
       VALUES (?, 'pending', ?)`
    )
    .run(scheduleId, totalItems);
  countWrite();
  return result.lastInsertRowid;
}

/**
 * Mark a batch execution as running.
 *
 * @param {number} batchId
 */
export function markBatchRunning(batchId) {
  db.prepare(
    `UPDATE batch_executions SET status = 'running' WHERE id = ?`
  ).run(batchId);
  countWrite();
}

/**
 * Mark a batch execution as completed and record summary counts.
 *
 * @param {number} batchId
 * @param {number} successCount
 * @param {number} failureCount
 */
export function markBatchCompleted(batchId, successCount, failureCount) {
  const status =
    failureCount === 0
      ? "completed"
      : successCount === 0
      ? "failed"
      : "completed"; // partial success still counts as 'completed'; use counts to distinguish

  db.prepare(`
    UPDATE batch_executions
    SET status = ?,
        successCount = ?,
        failureCount = ?,
        completedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, successCount, failureCount, batchId);
  countWrite();
}

/**
 * Mark a batch execution as failed with an error message.
 *
 * @param {number} batchId
 * @param {string} errorMessage
 */
export function markBatchFailed(batchId, errorMessage) {
  db.prepare(`
    UPDATE batch_executions
    SET status = 'failed',
        completedAt = CURRENT_TIMESTAMP,
        errorMessage = ?
    WHERE id = ?
  `).run(errorMessage, batchId);
  countWrite();
}

/**
 * Record the result of a single item within a batch execution.
 *
 * @param {number} batchExecutionId
 * @param {object} item
 * @param {string} item.contractId
 * @param {'success'|'failed'|'skipped'} item.status
 * @param {number|null} item.transactionId
 * @param {string|null} item.xdr
 * @param {string|null} item.errorMessage
 * @returns {number} The new item ID
 */
export function recordBatchItem(batchExecutionId, item) {
  const result = db
    .prepare(
      `INSERT INTO batch_execution_items
         (batchExecutionId, transactionId, contractId, status, xdr, errorMessage)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      batchExecutionId,
      item.transactionId ?? null,
      item.contractId,
      item.status,
      item.xdr ?? null,
      item.errorMessage ?? null
    );
  countWrite();
  return result.lastInsertRowid;
}

/**
 * Get a batch execution by ID, including its items.
 *
 * @param {number} batchId
 * @returns {{ execution: object|null, items: object[] }}
 */
export function getBatchExecution(batchId) {
  const execution =
    db
      .prepare(`SELECT * FROM batch_executions WHERE id = ?`)
      .get(batchId) ?? null;

  if (!execution) return { execution: null, items: [] };

  const items = db
    .prepare(
      `SELECT * FROM batch_execution_items WHERE batchExecutionId = ? ORDER BY id ASC`
    )
    .all(batchId);

  return { execution, items };
}

/**
 * List batch executions for a schedule, newest first.
 *
 * @param {number} scheduleId
 * @param {number} limit
 * @param {number} offset
 * @returns {object[]}
 */
export function listBatchExecutionsBySchedule(scheduleId, limit = 20, offset = 0) {
  return db
    .prepare(
      `SELECT * FROM batch_executions
       WHERE scheduleId = ?
       ORDER BY startedAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(scheduleId, limit, offset);
}

/**
 * List recent batch executions across all schedules (newest first).
 *
 * @param {number} limit
 * @param {number} offset
 * @returns {object[]}
 */
export function listRecentBatchExecutions(limit = 20, offset = 0) {
  return db
    .prepare(
      `SELECT be.*, ds.contractId as scheduleContractId, ds.frequency
       FROM batch_executions be
       LEFT JOIN distribution_schedules ds ON be.scheduleId = ds.id
       ORDER BY be.startedAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}
