import { Router } from "express";
import { prometheusMetrics } from "../metrics.js";

export const metricsRouter = Router();

metricsRouter.get("/", (_req, res) => {
  res.type("text/plain; version=0.0.4; charset=utf-8").send(prometheusMetrics());
});
