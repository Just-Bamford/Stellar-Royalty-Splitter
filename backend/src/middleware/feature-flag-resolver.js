/**
 * Feature Flag Resolver middleware (#1075)
 *
 * Attaches a per-request feature flag context and resolver so any route can
 * check a flag at runtime, and exposes `requireFeatureFlag()` to gate an
 * endpoint behind a flag.
 *
 * The caller identity is derived from the headers the rest of the API already
 * uses (`x-wallet-address`, `x-user-id`, `x-org-id`) plus the RBAC role that
 * `attachRole` puts on `req.role`.
 */

import { isEnabled, evaluateAll } from "../services/feature-flags.js";
import { sendError } from "../error-response.js";
import logger from "../logger.js";

/**
 * Derive the targeting context for a request.
 */
export function buildFeatureFlagContext(req) {
  return {
    walletAddress: req.headers["x-wallet-address"] || null,
    userId: req.headers["x-user-id"] || null,
    orgId: req.headers["x-org-id"] || null,
    role: req.role || null,
    apiKey: req.headers["x-api-key"] ? "present" : null,
    sessionId: req.headers["x-session-id"] || null,
  };
}

/**
 * Non-blocking middleware: attaches `req.featureFlagContext` and
 * `req.featureFlags` to every request. Resolving a flag never throws.
 */
export function attachFeatureFlags(req, _res, next) {
  req.featureFlagContext = buildFeatureFlagContext(req);
  req.featureFlags = {
    isEnabled: (name) => {
      try {
        return isEnabled(name, req.featureFlagContext);
      } catch (err) {
        logger.warn("Feature flag evaluation failed", { flag: name, error: err.message });
        return false;
      }
    },
    evaluate: (names) => {
      try {
        return evaluateAll(req.featureFlagContext, names);
      } catch (err) {
        logger.warn("Feature flag evaluation failed", { error: err.message });
        return {};
      }
    },
  };
  next();
}

/**
 * Express middleware that only lets a request through when `name` resolves to
 * true for the caller. Responds 404 (rather than 403) so a feature that is not
 * rolled out to a caller is indistinguishable from one that does not exist,
 * while still allowing the flag rollout to be measured.
 */
export function requireFeatureFlag(name, { denyStatus = 404 } = {}) {
  return (req, res, next) => {
    const context = req.featureFlagContext || buildFeatureFlagContext(req);
    let enabled = false;
    try {
      enabled = isEnabled(name, context);
    } catch (err) {
      logger.warn("Feature flag gate evaluation failed", { flag: name, error: err.message });
    }

    if (enabled) return next();

    logger.info("Feature flag gate blocked request", {
      flag: name,
      path: req.originalUrl,
      method: req.method,
    });
    return sendError(res, denyStatus, "feature_unavailable", "This feature is not available.");
  };
}
