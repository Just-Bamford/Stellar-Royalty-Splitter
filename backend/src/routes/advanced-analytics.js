import { Router } from "express";
import { getAdvancedAnalytics } from "../services/analytics-engine.js";

export const advancedAnalyticsRouter = Router();

advancedAnalyticsRouter.get("/analytics/advanced/:contractId", (req, res, next) => {
  try {
    const hours = Math.min(Math.max(Number.parseInt(req.query.hours ?? "24", 10) || 24, 1), 168);
    const days = Math.min(Math.max(Number.parseInt(req.query.days ?? "30", 10) || 30, 1), 365);
    const data = getAdvancedAnalytics(req.params.contractId, {
      hours,
      days,
      refresh: req.query.refresh === "true",
      onAlert: (anomaly) => req.app.emit("analytics:anomaly", { contractId: req.params.contractId, anomaly }),
    });
    res.set("Cache-Control", "private, max-age=30");
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});
