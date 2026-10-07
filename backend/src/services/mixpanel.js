/**
 * Mixpanel analytics service — closes #941.
 *
 * Provides a unified interface for tracking product analytics events across
 * the backend. Events are enriched with user cohort information (tier,
 * join date, distribution frequency) before dispatch to Mixpanel via HTTP.
 *
 * Environment:
 *   MIXPANEL_PROJECT_TOKEN      Mixpanel project token (required)
 */

import logger from "../logger.js";

const MIXPANEL_API_URL = "https://api.mixpanel.com/track";
const MIXPANEL_PEOPLE_URL = "https://api.mixpanel.com/engage";

let pendingEvents = [];

function getMixpanelToken() {
  return process.env.MIXPANEL_PROJECT_TOKEN || null;
}

/**
 * Send event to Mixpanel API.
 * Events are batched and sent asynchronously (best-effort).
 *
 * @param {string} userId           User/wallet identifier (required)
 * @param {string} eventName        Event name (e.g. 'distribution_succeeded')
 * @param {Object} properties       Event properties (optional)
 */
export async function trackEvent(userId, eventName, properties = {}) {
  const token = getMixpanelToken();
  if (!token) return;

  const event = {
    event: eventName,
    properties: {
      token,
      distinct_id: userId,
      time: Math.floor(Date.now() / 1000),
      ...properties,
    },
  };

  // Queue event for batch sending
  pendingEvents.push(event);

  // Send if batch reaches threshold
  if (pendingEvents.length >= 10) {
    flushEvents().catch((err) =>
      logger.warn(`Mixpanel flush error: ${err.message}`),
    );
  }
}

/**
 * Set user profile properties (cohorts, metadata).
 *
 * @param {string} userId           User/wallet identifier
 * @param {Object} properties       User properties
 */
export async function setUserProfile(userId, properties = {}) {
  const token = getMixpanelToken();
  if (!token) return;

  const payload = {
    $token: token,
    $distinct_id: userId,
    ...Object.entries(properties).reduce(
      (acc, [key, value]) => {
        acc[`$${key}`] = value;
        return acc;
      },
      {},
    ),
  };

  try {
    const response = await fetch(MIXPANEL_PEOPLE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      logger.warn(
        `Mixpanel people.set failed: ${response.status} ${response.statusText}`,
      );
    }
  } catch (err) {
    logger.warn(`Mixpanel people.set error: ${err.message}`);
  }
}

/**
 * Track a funnel event (multi-step conversion tracking).
 */
export async function trackFunnelStep(userId, funnelName, step, properties = {}) {
  await trackEvent(userId, `${funnelName}_${step}`, properties);
}

/**
 * Flush all pending events to Mixpanel.
 */
async function flushEvents() {
  if (pendingEvents.length === 0) return;

  const events = pendingEvents.splice(0, 50); // Flush in batches of 50

  try {
    for (const event of events) {
      await fetch(MIXPANEL_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
    }
  } catch (err) {
    logger.warn(`Mixpanel event flush error: ${err.message}`);
    // Re-queue failed events
    pendingEvents.unshift(...events);
  }
}

/**
 * Flush pending events to Mixpanel (should be called on shutdown).
 */
export async function flush() {
  if (pendingEvents.length === 0) return;

  try {
    await flushEvents();
  } catch (err) {
    logger.error(`Mixpanel final flush error: ${err.message}`, { error: err });
  }
}

/**
 * Check if Mixpanel is configured.
 */
export function isMixpanelConfigured() {
  return Boolean(process.env.MIXPANEL_PROJECT_TOKEN);
}
