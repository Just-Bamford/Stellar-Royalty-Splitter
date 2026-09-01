/**
 * Payment schedule template routes — closes #599.
 *
 * POST   /api/v1/payment-schedules          — create a schedule template
 * GET    /api/v1/payment-schedules          — list all schedules (query: contractId)
 * GET    /api/v1/payment-schedules/:id      — get a single schedule
 * PATCH  /api/v1/payment-schedules/:id      — update / enable / disable
 * DELETE /api/v1/payment-schedules/:id      — permanently delete
 * GET    /api/v1/payment-schedules/upcoming — upcoming distributions
 */

import { Router } from "express";
import { z } from "zod";
import { stellarAddress, contractAddress } from "../validation.js";
import { sendError, sendValidationError } from "../error-response.js";
import {
  createPaymentSchedule,
  getPaymentSchedule,
  listPaymentSchedules,
  countPaymentSchedules,
  updatePaymentSchedule,
  deletePaymentSchedule,
  getUpcomingSchedules,
  setNextRunAt,
  SCHEDULE_TYPES,
} from "../database/index.js";
import { computeNextRun } from "../schedule-calculator.js";
import { addAuditLog } from "../database/index.js";
import logger from "../logger.js";

export const paymentSchedulesRouter = Router();

// ─── Validation schemas ────────────────────────────────────────────────────────

const createScheduleSchema = z
  .object({
    name: z.string().min(1).max(100),
    type: z.enum(SCHEDULE_TYPES),
    contractId: contractAddress,
    tokenId: contractAddress,
    walletAddress: stellarAddress,
    dayOfMonth: z.number().int().min(1).max(28).optional().nullable(),
    dayOfWeek: z.number().int().min(0).max(6).optional().nullable(),
    intervalDays: z.number().int().min(1).max(365).optional().nullable(),
    anchorDate: z.string().datetime({ offset: true }).optional().nullable(),
    hourOfDay: z.number().int().min(0).max(23).optional().default(0),
    timezone: z.string().min(1).max(50).optional().default("UTC"),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .superRefine((d, ctx) => {
    if (d.type === "monthly" && d.dayOfMonth == null) {
      ctx.addIssue({
        code: "custom",
        path: ["dayOfMonth"],
        message: "dayOfMonth is required for monthly schedules",
      });
    }
    if (d.type === "weekly" && d.dayOfWeek == null) {
      ctx.addIssue({
        code: "custom",
        path: ["dayOfWeek"],
        message: "dayOfWeek is required for weekly schedules",
      });
    }
    if ((d.type === "biweekly" || d.type === "custom") && !d.anchorDate) {
      ctx.addIssue({
        code: "custom",
        path: ["anchorDate"],
        message: "anchorDate is required for biweekly/custom schedules",
      });
    }
    if (d.type === "custom" && d.intervalDays == null) {
      ctx.addIssue({
        code: "custom",
        path: ["intervalDays"],
        message: "intervalDays is required for custom schedules",
      });
    }
  });

const updateScheduleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional().nullable(),
  dayOfWeek: z.number().int().min(0).max(6).optional().nullable(),
  intervalDays: z.number().int().min(1).max(365).optional().nullable(),
  anchorDate: z.string().datetime({ offset: true }).optional().nullable(),
  hourOfDay: z.number().int().min(0).max(23).optional(),
  timezone: z.string().min(1).max(50).optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

const listQuerySchema = z.object({
  contractId: z.string().optional(),
  includeDisabled: z.coerce.boolean().optional().default(false),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// ─── POST /api/v1/payment-schedules ──────────────────────────────────────────

paymentSchedulesRouter.post("/", (req, res) => {
  const result = createScheduleSchema.safeParse(req.body);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  const data = result.data;
  const schedule = createPaymentSchedule(data);

  // Compute and persist the first next-run time
  try {
    const nextRunAt = computeNextRun(schedule);
    setNextRunAt(schedule.id, nextRunAt);
    schedule.nextRunAt = nextRunAt;
  } catch (err) {
    logger.warn("Could not compute nextRunAt for new schedule", { error: err.message });
  }

  addAuditLog(data.contractId, "payment_schedule_created", data.walletAddress, {
    scheduleId: schedule.id,
    type: data.type,
    name: data.name,
  });

  return res.status(201).json({ success: true, data: schedule });
});

// ─── GET /api/v1/payment-schedules/upcoming ──────────────────────────────────

paymentSchedulesRouter.get("/upcoming", (req, res) => {
  const contractId = req.query.contractId ?? null;
  const limit = Math.min(parseInt(req.query.limit ?? "10", 10), 50);
  const upcoming = getUpcomingSchedules(contractId, limit);
  return res.json({ success: true, data: upcoming });
});

// ─── GET /api/v1/payment-schedules ────────────────────────────────────────────

paymentSchedulesRouter.get("/", (req, res) => {
  const result = listQuerySchema.safeParse(req.query);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  const { contractId, includeDisabled, limit, offset } = result.data;
  const schedules = listPaymentSchedules(contractId, { includeDisabled, limit, offset });
  const total = countPaymentSchedules(contractId, { includeDisabled });

  return res.json({
    success: true,
    data: schedules,
    pagination: { total, limit, offset },
  });
});

// ─── GET /api/v1/payment-schedules/:id ────────────────────────────────────────

paymentSchedulesRouter.get("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return sendError(res, 400, "invalid_id", "Schedule ID must be a positive integer");
  }

  const schedule = getPaymentSchedule(id);
  if (!schedule) {
    return sendError(res, 404, "schedule_not_found", `No payment schedule with id ${id}`);
  }

  return res.json({ success: true, data: schedule });
});

// ─── PATCH /api/v1/payment-schedules/:id ─────────────────────────────────────

paymentSchedulesRouter.patch("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return sendError(res, 400, "invalid_id", "Schedule ID must be a positive integer");
  }

  const existing = getPaymentSchedule(id);
  if (!existing) {
    return sendError(res, 404, "schedule_not_found", `No payment schedule with id ${id}`);
  }

  const result = updateScheduleSchema.safeParse(req.body);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  const updates = result.data;
  const updated = updatePaymentSchedule(id, updates);

  // If schedule timing changed, recompute nextRunAt
  const timingFields = [
    "dayOfMonth",
    "dayOfWeek",
    "intervalDays",
    "anchorDate",
    "hourOfDay",
    "enabled",
  ];
  if (timingFields.some((f) => f in updates)) {
    try {
      const merged = { ...existing, ...updates };
      if (merged.enabled !== false) {
        const nextRunAt = computeNextRun(merged);
        setNextRunAt(id, nextRunAt);
        updated.nextRunAt = nextRunAt;
      }
    } catch (err) {
      logger.warn("Could not recompute nextRunAt after schedule update", {
        id,
        error: err.message,
      });
    }
  }

  addAuditLog(existing.contractId, "payment_schedule_updated", "system", {
    scheduleId: id,
    updates,
  });

  return res.json({ success: true, data: updated });
});

// ─── DELETE /api/v1/payment-schedules/:id ────────────────────────────────────

paymentSchedulesRouter.delete("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return sendError(res, 400, "invalid_id", "Schedule ID must be a positive integer");
  }

  const existing = getPaymentSchedule(id);
  if (!existing) {
    return sendError(res, 404, "schedule_not_found", `No payment schedule with id ${id}`);
  }

  deletePaymentSchedule(id);

  addAuditLog(existing.contractId, "payment_schedule_deleted", "system", {
    scheduleId: id,
    name: existing.name,
  });

  return res.json({ success: true, message: `Schedule ${id} deleted` });
});
