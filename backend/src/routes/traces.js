import { Router } from "express";
import { getTraces } from "../tracing.js";

export const tracesRouter = Router();

/**
 * GET /api/v1/traces/:correlationId
 * Retrieves tracing spans for a given request correlation ID (#481)
 */
tracesRouter.get("/:correlationId", (req, res) => {
  const { correlationId } = req.params;
  const traces = getTraces(correlationId);
  res.json({ success: true, traces });
});
