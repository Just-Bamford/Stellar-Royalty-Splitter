import { Router } from "express";
import { prometheusMetrics } from "../metrics.js";

export const metricsRouter = Router();

metricsRouter.get("/", async (_req, res) => {
  try {
    const body = await prometheusMetrics();
    res.type("text/plain; version=0.0.4; charset=utf-8").send(body);
  } catch (err) {
    res.status(500).type("text/plain").send("failed to serialize metrics");
  }
});
