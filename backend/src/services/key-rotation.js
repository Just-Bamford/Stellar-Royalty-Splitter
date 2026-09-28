/**
 * Key rotation service for automatic secret rotation.
 *
 * Supports:
 * - Signing key rotation (90 days)
 * - Database credential rotation (6 months)
 * - API key rotation (quarterly)
 * - Graceful transition with 2 active keys
 */

import logger from "../logger.js";
import { loadSigningSecret, encryptSecret, decryptSecret } from "../secrets-manager.js";

const ROTATION_SCHEDULES = {
  SIGNING_KEY: 90 * 24 * 60 * 60 * 1000, // 90 days
  DB_CREDENTIALS: 180 * 24 * 60 * 60 * 1000, // 6 months
  API_KEYS: 90 * 24 * 60 * 60 * 1000, // quarterly
};

const TRANSITION_PERIOD = 7 * 24 * 60 * 60 * 1000; // 7 days

let activeKeys = {
  signing: { primary: null, secondary: null, primaryCreatedAt: null },
  db: { primary: null, secondary: null, primaryCreatedAt: null },
  api: { primary: null, secondary: null, primaryCreatedAt: null },
};

async function initializeKeys() {
  try {
    const signingKey = await loadSigningSecret();
    if (signingKey) {
      activeKeys.signing.primary = signingKey;
      activeKeys.signing.primaryCreatedAt = Date.now();
    }
  } catch (error) {
    logger.warn("Failed to initialize signing key", { error: error.message });
  }
}

function shouldRotate(keyType) {
  const keys = activeKeys[keyType];
  if (!keys.primary || !keys.primaryCreatedAt) {
    return true;
  }
  const schedule = ROTATION_SCHEDULES[keyType];
  return Date.now() - keys.primaryCreatedAt > schedule;
}

async function rotateKey(keyType) {
  logger.info(`Rotating ${keyType} key`, { keyType });

  try {
    let newKey;
    if (keyType === "signing") {
      newKey = await loadSigningSecret();
    } else {
      newKey = generateNewKey(keyType);
    }

    if (!newKey) {
      throw new Error(`Failed to generate new ${keyType} key`);
    }

    const keys = activeKeys[keyType];
    keys.secondary = keys.primary;
    keys.primary = newKey;
    keys.primaryCreatedAt = Date.now();

    logger.info(`Successfully rotated ${keyType} key`, { keyType });

    setTimeout(() => {
      keys.secondary = null;
      logger.info(`Transition period ended for ${keyType}, secondary key removed`, { keyType });
    }, TRANSITION_PERIOD);

    return true;
  } catch (error) {
    logger.error(`Failed to rotate ${keyType} key`, { keyType, error: error.message });
    return false;
  }
}

function generateNewKey(keyType) {
  const crypto = require("crypto");
  if (keyType === "db") {
    return crypto.randomBytes(32).toString("hex");
  }
  if (keyType === "api") {
    return crypto.randomBytes(24).toString("base64");
  }
  return null;
}

export async function checkAndRotateKeys() {
  const results = {};

  for (const keyType of Object.keys(ROTATION_SCHEDULES)) {
    if (shouldRotate(keyType)) {
      results[keyType] = await rotateKey(keyType);
    } else {
      results[keyType] = false;
    }
  }

  return results;
}

export function getActiveKey(keyType) {
  const keys = activeKeys[keyType];
  return keys.primary || keys.secondary;
}

export function getKeyStatus(keyType) {
  const keys = activeKeys[keyType];
  return {
    hasPrimary: !!keys.primary,
    hasSecondary: !!keys.secondary,
    primaryAge: keys.primaryCreatedAt ? Date.now() - keys.primaryCreatedAt : null,
    needsRotation: shouldRotate(keyType),
  };
}

export async function startRotationScheduler() {
  await initializeKeys();

  setInterval(async () => {
    await checkAndRotateKeys();
  }, 24 * 60 * 60 * 1000); // Check daily

  logger.info("Key rotation scheduler started");
}
