/**
 * Analytics event tracking middleware — closes #941.
 *
 * Automatically tracks key events based on route and response status.
 * Can be applied to specific routes or globally.
 */

import { trackEvent, setUserProfile, trackFunnelStep } from "../services/mixpanel.js";
import logger from "../logger.js";

/**
 * Middleware to track distribution events.
 *
 * Usage:
 *   distributeRouter.post("/", trackDistributionEvents, handleDistribute);
 *
 * Tracks:
 *   - distribute_submitted (on request)
 *   - distribute_succeeded (on 200 response)
 *   - distribute_failed (on 4xx/5xx response)
 */
export function trackDistributionEvents(req, res, next) {
  const userId = req.user?.address || req.headers["x-user-id"];
  if (!userId) {
    return next();
  }

  // Track submission
  trackEvent(userId, "distribute_clicked", {
    timestamp: Date.now(),
  }).catch((err) => logger.warn(`Failed to track distribute_clicked: ${err.message}`));

  // Hook into response
  const originalJson = res.json;
  res.json = function (data) {
    const statusCode = res.statusCode;
    if (statusCode === 200) {
      trackEvent(userId, "distribution_succeeded", {
        timestamp: Date.now(),
        ...(data?.data?.transactionHash && { txHash: data.data.transactionHash }),
      }).catch((err) =>
        logger.warn(`Failed to track distribution_succeeded: ${err.message}`),
      );
    } else if (statusCode >= 400) {
      trackEvent(userId, "distribution_failed", {
        timestamp: Date.now(),
        statusCode,
        error: data?.code || "unknown",
      }).catch((err) =>
        logger.warn(`Failed to track distribution_failed: ${err.message}`),
      );
    }
    return originalJson.call(this, data);
  };

  next();
}

/**
 * Middleware to track wallet connection attempts and secondary royalty events.
 *
 * Tracks:
 *   - secondary_royalty_recorded (on POST /secondary-royalty with success)
 */
export function trackSecondaryRoyaltyEvents(req, res, next) {
  const userId = req.user?.address || req.headers["x-user-id"];
  if (!userId) {
    return next();
  }

  const originalJson = res.json;
  res.json = function (data) {
    if (res.statusCode === 200 && data?.data) {
      trackEvent(userId, "secondary_royalty_recorded", {
        timestamp: Date.now(),
        amount: data.data.amount,
        source: data.data.source,
      }).catch((err) =>
        logger.warn(`Failed to track secondary_royalty_recorded: ${err.message}`),
      );
    }
    return originalJson.call(this, data);
  };

  next();
}

/**
 * Middleware to track contract initialization.
 *
 * Tracks:
 *   - initialize_started (on request)
 *   - initialize_completed (on 200 response)
 */
export function trackInitializationEvents(req, res, next) {
  const userId = req.user?.address || req.headers["x-user-id"];
  if (!userId) {
    return next();
  }

  trackEvent(userId, "initialize_started", {
    timestamp: Date.now(),
  }).catch((err) => logger.warn(`Failed to track initialize_started: ${err.message}`));

  const originalJson = res.json;
  res.json = function (data) {
    if (res.statusCode === 200) {
      trackEvent(userId, "initialize_completed", {
        timestamp: Date.now(),
        ...(data?.data?.transactionHash && { txHash: data.data.transactionHash }),
      }).catch((err) =>
        logger.warn(`Failed to track initialize_completed: ${err.message}`),
      );
    }
    return originalJson.call(this, data);
  };

  next();
}

/**
 * Track user cohort information when they connect or initialize.
 *
 * @param {string} userId Stellar address
 * @param {string} tier Collaborator tier (e.g., 'gold', 'silver', 'bronze')
 * @param {string} joinDate ISO date string
 * @param {number} distributionFrequency Estimated days between distributions
 */
export async function trackUserCohort(userId, { tier, joinDate, distributionFrequency }) {
  if (!userId) return;

  setUserProfile(userId, {
    collaborator_tier: tier,
    join_date: joinDate,
    distribution_frequency: distributionFrequency,
    last_updated: new Date().toISOString(),
  }).catch((err) => logger.warn(`Failed to track user cohort: ${err.message}`));
}

/**
 * Initialize tracking for a user after they sign up or first connect.
 *
 * @param {string} userId Stellar address
 * @param {string} tier Collaborator tier
 */
export async function initializeUserTracking(userId, tier = "standard") {
  if (!userId) return;

  const joinDate = new Date().toISOString();
  await trackUserCohort(userId, {
    tier,
    joinDate,
    distributionFrequency: null,
  });

  trackEvent(userId, "user_initialized", {
    timestamp: Date.now(),
    tier,
  }).catch((err) => logger.warn(`Failed to track user_initialized: ${err.message}`));
}

export {};
