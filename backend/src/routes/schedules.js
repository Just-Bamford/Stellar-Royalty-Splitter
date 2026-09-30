/**
 * Routes for distribution schedule management and batch execution.
 *
 * Endpoints:
 *   GET    /api/v1/schedules?contractId=…        List schedules for a contract
 *   POST   /api/v1/schedules                     Create a new schedule
 *   GET    /api/v1/schedules/:id                 Get a single schedule
 *   PATCH  /api/v1/schedules/:id                 Update / pause / resume
 *   DELETE /api/v1/schedules/:id                 Delete a schedule
 *   GET    /api/v1/schedules/:id/history         Execution history for a schedule
 *   GET    /api/v1/schedules/:id/history/:batchId Full batch execution detail
 *   POST   /api/v1/batch                         Execute an ad-hoc batch immediately
 */

import { Router } from "express";
import {
  validate,
  createScheduleSchema,
  updateScheduleSchema,
  executeBatchSchema,
  validateContractId,
  parsePagination,
} from "../validation.js";
import {
  createSchedule,
  getScheduleById,
  listSchedulesByContract,
  countSchedulesByContract,
  updateSchedule,
  deleteSchedule,
  getBatchExecution,
  listBatchExecutionsBySchedule,
  listRecentBatchExecutions,
} from "../database/schedules.js";
import { addAuditLog } from "../database/index.js";
import { computeNextRunAt } from "../services/distribution-scheduler.js";
import { executeBatch } from "../services/batch-processor.js";
import { sendError } from "../error-response.js";

export const schedulesRouter = Router();
export const batchRouter = Router();

// ── Helper ─────────────────────────────────────────────────────────────────────

function scheduleNotFound(res, id) {
  return sendError(res, 404, "schedule_not_found", `Schedule ${id} not found`);
}

// ── GET /api/v1/schedules?contractId=… ────────────────────────────────────────

schedulesRouter.get("/", (req, res) => {
  const { contractId } = req.query;

  if (!contractId) {
    return sendError(res, 400, "missing_parameter", "contractId query parameter is required");
  }

  if (!validateContractId(contractId, res)) return;

  const pagination = parsePagination(req.query, res);
  if (!pagination) return;

  const schedules = listSchedulesByContract(contractId, pagination.limit, pagination.offset);
  const total = countSchedulesByContract(contractId);

  res.json({ schedules, total, limit: pagination.limit, offset: pagination.offset });
});

// ── POST /api/v1/schedules ─────────────────────────────────────────────────────

schedulesRouter.post("/", validate(createScheduleSchema), (req, res) => {
  const {
    contractId,
    walletAddress,
    tokenId,
    frequency,
    dayOfWeek,
    dayOfMonth,
    hourOfDay,
    minuteOfHour,
  } = req.body;

  // Compute when the schedule should first run
  const nextRunAt = computeNextRunAt({
    frequency,
    dayOfWeek: dayOfWeek ?? null,
    dayOfMonth: dayOfMonth ?? null,
    hourOfDay: hourOfDay ?? 0,
    minuteOfHour: minuteOfHour ?? 0,
  });

  const scheduleId = createSchedule({
    contractId,
    walletAddress,
    tokenId,
    frequency,
    dayOfWeek: dayOfWeek ?? null,
    dayOfMonth: dayOfMonth ?? null,
    hourOfDay: hourOfDay ?? 0,
    minuteOfHour: minuteOfHour ?? 0,
    nextRunAt,
  });

  addAuditLog(contractId, "schedule_created", walletAddress, {
    scheduleId,
    frequency,
    nextRunAt,
  });

  const schedule = getScheduleById(scheduleId);
  res.status(201).json({ schedule });
});

// ── GET /api/v1/schedules/:id ──────────────────────────────────────────────────

schedulesRouter.get("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return sendError(res, 400, "invalid_parameter", "Schedule ID must be a positive integer");
  }

  const schedule = getScheduleById(id);
  if (!schedule) return scheduleNotFound(res, id);

  res.json({ schedule });
});

// ── PATCH /api/v1/schedules/:id ────────────────────────────────────────────────

schedulesRouter.patch("/:id", validate(updateScheduleSchema), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return sendError(res, 400, "invalid_parameter", "Schedule ID must be a positive integer");
  }

  const existing = getScheduleById(id);
  if (!existing) return scheduleNotFound(res, id);

  const updates = {};
  const {
    frequency,
    dayOfWeek,
    dayOfMonth,
    hourOfDay,
    minuteOfHour,
    enabled,
  } = req.body;

  if (frequency !== undefined) updates.frequency = frequency;
  if (dayOfWeek !== undefined) updates.dayOfWeek = dayOfWeek;
  if (dayOfMonth !== undefined) updates.dayOfMonth = dayOfMonth;
  if (hourOfDay !== undefined) updates.hourOfDay = hourOfDay;
  if (minuteOfHour !== undefined) updates.minuteOfHour = minuteOfHour;
  if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;

  // If timing fields changed, recompute nextRunAt from the merged schedule
  const timingChanged =
    frequency !== undefined ||
    dayOfWeek !== undefined ||
    dayOfMonth !== undefined ||
    hourOfDay !== undefined ||
    minuteOfHour !== undefined;

  if (timingChanged) {
    const merged = {
      frequency: frequency ?? existing.frequency,
      dayOfWeek: dayOfWeek !== undefined ? dayOfWeek : existing.dayOfWeek,
      dayOfMonth: dayOfMonth !== undefined ? dayOfMonth : existing.dayOfMonth,
      hourOfDay: hourOfDay ?? existing.hourOfDay,
      minuteOfHour: minuteOfHour ?? existing.minuteOfHour,
    };
    updates.nextRunAt = computeNextRunAt(merged);
  }

  if (Object.keys(updates).length === 0) {
    return sendError(res, 400, "no_changes", "No updatable fields provided");
  }

  updateSchedule(id, updates);

  addAuditLog(existing.contractId, "schedule_updated", existing.walletAddress, {
    scheduleId: id,
    updates,
  });

  const updated = getScheduleById(id);
  res.json({ schedule: updated });
});

// ── DELETE /api/v1/schedules/:id ───────────────────────────────────────────────

schedulesRouter.delete("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return sendError(res, 400, "invalid_parameter", "Schedule ID must be a positive integer");
  }

  const existing = getScheduleById(id);
  if (!existing) return scheduleNotFound(res, id);

  deleteSchedule(id);

  addAuditLog(existing.contractId, "schedule_deleted", existing.walletAddress, {
    scheduleId: id,
  });

  res.status(204).end();
});

// ── GET /api/v1/schedules/:id/history ─────────────────────────────────────────

schedulesRouter.get("/:id/history", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return sendError(res, 400, "invalid_parameter", "Schedule ID must be a positive integer");
  }

  if (!getScheduleById(id)) return scheduleNotFound(res, id);

  const pagination = parsePagination(req.query, res, 20, 100);
  if (!pagination) return;

  const executions = listBatchExecutionsBySchedule(id, pagination.limit, pagination.offset);
  res.json({ executions, limit: pagination.limit, offset: pagination.offset });
});

// ── GET /api/v1/schedules/:id/history/:batchId ────────────────────────────────

schedulesRouter.get("/:id/history/:batchId", (req, res) => {
  const scheduleId = parseInt(req.params.id, 10);
  const batchId = parseInt(req.params.batchId, 10);

  if (!Number.isInteger(scheduleId) || scheduleId <= 0) {
    return sendError(res, 400, "invalid_parameter", "Schedule ID must be a positive integer");
  }
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return sendError(res, 400, "invalid_parameter", "Batch ID must be a positive integer");
  }

  if (!getScheduleById(scheduleId)) return scheduleNotFound(res, scheduleId);

  const { execution, items } = getBatchExecution(batchId);
  if (!execution) {
    return sendError(res, 404, "batch_not_found", `Batch execution ${batchId} not found`);
  }

  // Ensure the batch belongs to this schedule
  if (execution.scheduleId !== scheduleId) {
    return sendError(res, 404, "batch_not_found", `Batch execution ${batchId} not found`);
  }

  res.json({ execution, items });
});

// ── POST /api/v1/batch ─────────────────────────────────────────────────────────
// Ad-hoc batch execution — executes immediately without a schedule

batchRouter.post(
  "/",
  validate(executeBatchSchema),
  async (req, res, next) => {
    try {
      const { items } = req.body;

      const result = await executeBatch(items, null);

      // Audit each unique contractId in the batch
      const contractIds = [...new Set(items.map((i) => i.contractId))];
      for (const contractId of contractIds) {
        addAuditLog(contractId, "ad_hoc_batch_executed", "api", {
          batchId: result.batchId,
          totalItems: result.totalItems,
          successCount: result.successCount,
          failureCount: result.failureCount,
        });
      }

      res.status(result.failureCount > 0 ? 207 : 200).json({
        batchId: result.batchId,
        totalItems: result.totalItems,
        successCount: result.successCount,
        failureCount: result.failureCount,
        results: result.results,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/v1/batch/history ─────────────────────────────────────────────────
// Recent batch executions across all schedules (useful for admin dashboards)

batchRouter.get("/history", (req, res) => {
  const pagination = parsePagination(req.query, res, 20, 100);
  if (!pagination) return;

  const executions = listRecentBatchExecutions(pagination.limit, pagination.offset);
  res.json({ executions, limit: pagination.limit, offset: pagination.offset });
});
