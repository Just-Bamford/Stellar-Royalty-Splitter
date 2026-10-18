/**
 * Feature Flags Express API (#1075)
 *
 * Runtime management of feature flags, targeting rules, gradual rollout,
 * metrics/monitoring, rollback, and audit history.
 *
 * Mutating endpoints require the `admin` role (or the legacy
 * ADMIN_ROTATE_TOKEN bearer). Evaluation endpoints are read-only and are used
 * by the middleware and the UI.
 */

import { Router } from "express";
import {
  validate,
  createFeatureFlagSchema,
  updateFeatureFlagSchema,
  createFeatureFlagRuleSchema,
  featureFlagRolloutSchema,
  featureFlagMetricSchema,
  featureFlagMonitorSchema,
  evaluateFeatureFlagSchema,
} from "../validation.js";
import {
  createFlag,
  getFlag,
  listFlags,
  updateFlag,
  deleteFlag,
  addRule,
  removeRule,
  setRollout,
  rollback,
  getHistory,
  checkRolloutHealth,
  monitorRollout,
  evaluateAll,
  isEnabled,
  recordMetric,
} from "../services/feature-flags.js";
import { requireAdminBearerOrRole } from "../middleware/rbac.js";
import { buildFeatureFlagContext } from "../middleware/feature-flag-resolver.js";
import { sendError } from "../error-response.js";
import logger from "../logger.js";

export const featureFlagsRouter = Router();

const adminOnly = requireAdminBearerOrRole("admin");

/** Map service-layer validation errors onto the standard API error shape. */
function handleServiceError(err, res, next) {
  const message = err?.message || "Feature flag operation failed";
  if (/not found/.test(message)) {
    return sendError(res, 404, "feature_flag_not_found", message);
  }
  if (/already exists/.test(message)) {
    return sendError(res, 409, "feature_flag_exists", message);
  }
  if (/Invalid|must be|required/.test(message)) {
    return sendError(res, 400, "invalid_feature_flag", message);
  }
  return next(err);
}

/**
 * POST /api/v1/feature-flags/evaluate
 * Batch-evaluate flags for an explicit context. Falls back to the caller's
 * headers (wallet/user/org/role) when no context is supplied.
 * Declared before `/:name` so "evaluate" is not treated as a flag name.
 */
featureFlagsRouter.post("/evaluate", validate(evaluateFeatureFlagSchema), (req, res, next) => {
  try {
    const context = {
      ...buildFeatureFlagContext(req),
      ...(req.body.context || {}),
    };
    const flags = evaluateAll(context, req.body.names || null);
    res.json({ context: sanitizeContext(context), flags });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/feature-flags/evaluate/:name
 * Evaluate a single flag for the caller.
 */
featureFlagsRouter.get("/evaluate/:name", (req, res, next) => {
  try {
    const context = {
      ...buildFeatureFlagContext(req),
      walletAddress: req.query.walletAddress || req.headers["x-wallet-address"] || null,
      orgId: req.query.orgId || req.headers["x-org-id"] || null,
      userId: req.query.userId || req.headers["x-user-id"] || null,
    };
    const enabled = isEnabled(req.params.name, context);
    res.json({ name: req.params.name, enabled, context: sanitizeContext(context) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/feature-flags
 * List flags with their rules.
 */
featureFlagsRouter.get("/", (req, res, next) => {
  try {
    const includeArchived = req.query.includeArchived === "true";
    res.json({ flags: listFlags({ includeArchived }) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/feature-flags
 * Create a flag.
 */
featureFlagsRouter.post("/", adminOnly, validate(createFeatureFlagSchema), (req, res, next) => {
  try {
    const createdBy = req.headers["x-wallet-address"] || "admin";
    const flag = createFlag({ ...req.body, createdBy });
    res.status(201).json(flag);
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

/**
 * GET /api/v1/feature-flags/:name
 */
featureFlagsRouter.get("/:name", (req, res, next) => {
  try {
    const flag = getFlag(req.params.name);
    if (!flag) return sendError(res, 404, "feature_flag_not_found", "Feature flag not found");
    res.json(flag);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/v1/feature-flags/:name
 */
featureFlagsRouter.patch("/:name", adminOnly, validate(updateFeatureFlagSchema), (req, res, next) => {
  try {
    const changedBy = req.headers["x-wallet-address"] || "admin";
    const flag = updateFlag(req.params.name, req.body, changedBy);
    res.json(flag);
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

/**
 * DELETE /api/v1/feature-flags/:name
 * Archives the flag (history and metrics are preserved).
 */
featureFlagsRouter.delete("/:name", adminOnly, (req, res, next) => {
  try {
    const changedBy = req.headers["x-wallet-address"] || "admin";
    const flag = deleteFlag(req.params.name, changedBy);
    res.json({ success: true, flag });
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

/**
 * POST /api/v1/feature-flags/:name/rules
 * Add a targeting rule (user/org/role).
 */
featureFlagsRouter.post(
  "/:name/rules",
  adminOnly,
  validate(createFeatureFlagRuleSchema),
  (req, res, next) => {
    try {
      const changedBy = req.headers["x-wallet-address"] || "admin";
      const rule = addRule(req.params.name, req.body, changedBy);
      res.status(201).json(rule);
    } catch (err) {
      handleServiceError(err, res, next);
    }
  }
);

/**
 * DELETE /api/v1/feature-flags/:name/rules/:ruleId
 */
featureFlagsRouter.delete("/:name/rules/:ruleId", adminOnly, (req, res, next) => {
  try {
    const changedBy = req.headers["x-wallet-address"] || "admin";
    removeRule(req.params.name, req.params.ruleId, changedBy);
    res.json({ success: true });
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

/**
 * POST /api/v1/feature-flags/:name/rollout
 * Set the gradual rollout percentage.
 */
featureFlagsRouter.post(
  "/:name/rollout",
  adminOnly,
  validate(featureFlagRolloutSchema),
  (req, res, next) => {
    try {
      const changedBy = req.headers["x-wallet-address"] || "admin";
      const flag = setRollout(req.params.name, req.body.percentage, changedBy);
      res.json(flag);
    } catch (err) {
      handleServiceError(err, res, next);
    }
  }
);

/**
 * POST /api/v1/feature-flags/:name/rollback
 * Immediately and safely disable the flag (kill switch).
 */
featureFlagsRouter.post("/:name/rollback", adminOnly, (req, res, next) => {
  try {
    const changedBy = req.headers["x-wallet-address"] || "admin";
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "Manual rollback";
    const flag = rollback(req.params.name, changedBy, reason);
    res.json(flag);
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

/**
 * GET /api/v1/feature-flags/:name/history
 */
featureFlagsRouter.get("/:name/history", adminOnly, (req, res, next) => {
  try {
    res.json({ flag: req.params.name, history: getHistory(req.params.name) });
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

/**
 * GET /api/v1/feature-flags/:name/metrics
 * Aggregated error/latency metrics over a trailing window.
 */
featureFlagsRouter.get("/:name/metrics", adminOnly, (req, res, next) => {
  try {
    const windowMs = req.query.windowMs ? Number(req.query.windowMs) : 3600_000;
    const health = checkRolloutHealth(req.params.name, { windowMs });
    res.json(health);
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

/**
 * POST /api/v1/feature-flags/:name/metrics
 * Record a single request/error/latency sample.
 */
featureFlagsRouter.post(
  "/:name/metrics",
  adminOnly,
  validate(featureFlagMetricSchema),
  (req, res, next) => {
    try {
      const sample = recordMetric(req.params.name, req.body);
      res.status(201).json(sample);
    } catch (err) {
      handleServiceError(err, res, next);
    }
  }
);

/**
 * POST /api/v1/feature-flags/:name/monitor
 * Evaluate rollout health and optionally auto-rollback on breach.
 */
featureFlagsRouter.post(
  "/:name/monitor",
  adminOnly,
  validate(featureFlagMonitorSchema),
  (req, res, next) => {
    try {
      const changedBy = req.headers["x-wallet-address"] || "admin";
      const result = monitorRollout(req.params.name, {
        thresholds: {
          maxErrorRate: req.body.maxErrorRate,
          maxP95LatencyMs: req.body.maxP95LatencyMs,
          windowMs: req.body.windowMs,
        },
        autoRollback: req.body.autoRollback,
        changedBy,
      });
      res.json(result);
    } catch (err) {
      handleServiceError(err, res, next);
    }
  }
);

function sanitizeContext(context) {
  return {
    walletAddress: context?.walletAddress || null,
    userId: context?.userId || null,
    orgId: context?.orgId || null,
    role: context?.role || null,
  };
}

logger.info("Feature flag routes registered");
