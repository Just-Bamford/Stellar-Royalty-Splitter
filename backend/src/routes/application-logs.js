import { Router } from "express";
import { requireAdminBearerOrRole } from "../middleware/rbac.js";
import {
  evaluateLogAlerts,
  pruneApplicationLogs,
  queryApplicationLogs,
} from "../database/application-logs.js";

export const applicationLogsRouter = Router();
const operator = requireAdminBearerOrRole("operator");

applicationLogsRouter.get("/logs", operator, (req, res) => {
  const logs = queryApplicationLogs({
    level: req.query.level,
    correlationId: req.query.correlationId,
    requestId: req.query.requestId,
    service: req.query.service,
    search: req.query.search,
    from: req.query.from,
    to: req.query.to,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.json({ success: true, data: logs, count: logs.length });
});

applicationLogsRouter.get("/logs/alerts", operator, (req, res) => {
  res.json({ success: true, data: evaluateLogAlerts({
    windowMinutes: req.query.windowMinutes,
    errorThreshold: req.query.errorThreshold,
  }) });
});

applicationLogsRouter.post("/logs/retention/prune", operator, (req, res) => {
  const result = pruneApplicationLogs(req.body?.retentionDays ?? process.env.LOG_RETENTION_DAYS);
  res.json({ success: true, data: result });
});
