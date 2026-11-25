import { Router } from "express";
import { requireAdminBearerOrRole } from "../middleware/rbac.js";
import {
  countApplicationLogs,
  evaluateLogAlerts,
  pruneApplicationLogs,
  queryApplicationLogs,
} from "../database/application-logs.js";
import { sendError } from "../error-response.js";

export const applicationLogsRouter = Router();
const operator = requireAdminBearerOrRole("operator");

applicationLogsRouter.get("/logs", operator, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const filters = {
    level: req.query.level,
    correlationId: req.query.correlationId,
    requestId: req.query.requestId,
    service: req.query.service,
    search: req.query.search,
    from: req.query.from,
    to: req.query.to,
  };
  const logs = queryApplicationLogs({ ...filters, limit, offset });
  const total = countApplicationLogs(filters);
  res.json({ success: true, data: logs, count: logs.length, total, limit, offset });
});

applicationLogsRouter.get("/logs/alerts", operator, (req, res) => {
  res.json({ success: true, data: evaluateLogAlerts({
    windowMinutes: req.query.windowMinutes,
    errorThreshold: req.query.errorThreshold,
  }) });
});

applicationLogsRouter.post("/logs/retention/prune", operator, (req, res) => {
  const retentionDays = Number(req.body?.retentionDays ?? process.env.LOG_RETENTION_DAYS ?? 30);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    return sendError(res, 400, "invalid_parameter", "retentionDays must be between 1 and 365");
  }
  const result = pruneApplicationLogs(retentionDays);
  res.json({ success: true, data: result });
});
