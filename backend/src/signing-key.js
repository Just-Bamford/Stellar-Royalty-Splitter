/**
 * Server signing key lifecycle (#293).
 *
 * Loads the key from encrypted secrets stores (AWS Secrets Manager, HashiCorp Vault)
 * or plaintext fallback (SIGNING_KEY_FILE, SERVER_SECRET_KEY), keeps it in memory
 * for hot rotation without redeploy, and never logs secret material.
 */
import { readFileSync, existsSync } from "fs";
import { timingSafeEqual } from "crypto";
import StellarSdk from "@stellar/stellar-sdk";
import logger from "./logger.js";
import { loadSigningSecret, getSecretsProviderStatus } from "./secrets-manager.js";

const { Keypair } = StellarSdk;

let activeKeypair = null;
let lastRotationAt = null;
let lastRotationSource = null;

function normalizeSecret(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse and validate a Stellar secret key. Throws on invalid input.
 */
export function parseSigningSecret(secret) {
  const normalized = normalizeSecret(secret);
  if (!normalized) {
    throw new Error("Signing secret key is required");
  }
  if (!normalized.startsWith("S")) {
    throw new Error("Signing secret key must start with 'S'");
  }
  try {
    return Keypair.fromSecret(normalized);
  } catch {
    throw new Error("Invalid Stellar signing secret key");
  }
}

function readSecretsFilePath() {
  return normalizeSecret(process.env.SIGNING_KEY_FILE);
}

function readSecretFromFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Signing key file not found: ${filePath}`);
  }
  const contents = readFileSync(filePath, "utf8");
  return normalizeSecret(contents);
}

function setActiveKeypair(keypair, source) {
  const previousPublicKey = activeKeypair?.publicKey() ?? null;
  activeKeypair = keypair;
  lastRotationAt = new Date().toISOString();
  lastRotationSource = source;

  logger.info("Signing key rotated", {
    event: "signing_key_rotated",
    source,
    previousPublicKey,
    publicKey: keypair.publicKey(),
    rotatedAt: lastRotationAt,
  });
}

/**
 * Load signing key from secrets provider (AWS, Vault, file, or env).
 * Missing configuration is allowed (server may run without a signing key).
 */
export async function initializeSigningKey() {
  try {
    const secret = await loadSigningSecret();

    if (!secret) {
      activeKeypair = null;
      lastRotationAt = null;
      lastRotationSource = null;
      logger.warn("No server signing key configured", {
        event: "signing_key_unconfigured",
      });
      return null;
    }

    activeKeypair = parseSigningSecret(secret);
    const providerStatus = getSecretsProviderStatus();
    lastRotationSource = providerStatus.provider;
    lastRotationAt = new Date().toISOString();

    logger.info("Signing key loaded from secrets provider", {
      event: "signing_key_loaded",
      source: lastRotationSource,
      publicKey: activeKeypair.publicKey(),
      encrypted: providerStatus.encryptionKeyConfigured,
    });

    return activeKeypair;
  } catch (error) {
    logger.error("Failed to initialize signing key", {
      event: "signing_key_init_failed",
      error: error.message,
    });
    throw error;
  }
}

export function getSigningKeypair() {
  return activeKeypair;
}

export function getSigningPublicKey() {
  return activeKeypair?.publicKey() ?? null;
}

export function getSigningKeyStatus() {
  const providerStatus = getSecretsProviderStatus();
  return {
    configured: activeKeypair !== null,
    publicKey: getSigningPublicKey(),
    lastRotationAt,
    lastRotationSource,
    secretsProvider: providerStatus.provider,
    encryptionEnabled: providerStatus.encryptionKeyConfigured,
  };
}

/**
 * Hot-reload the in-memory signing key from a new secret.
 */
export function rotateSigningKey(secret, { source = "api" } = {}) {
  const keypair = parseSigningSecret(secret);
  setActiveKeypair(keypair, source);
  return {
    publicKey: keypair.publicKey(),
    rotatedAt: lastRotationAt,
    source: lastRotationSource,
  };
}

/**
 * Re-read signing key from secrets provider and apply the updated secret without redeploy.
 */
export async function reloadSigningKeyFromSecretsProvider() {
  try {
    const secret = await loadSigningSecret();
    if (!secret) {
      throw new Error("No signing key available from secrets provider");
    }
    return rotateSigningKey(secret, { source: "secrets_reload" });
  } catch (error) {
    logger.error("Failed to reload signing key from secrets provider", {
      event: "signing_key_reload_failed",
      error: error.message,
    });
    throw error;
  }
}

/**
 * Re-read SIGNING_KEY_FILE and apply the updated secret without redeploy.
 * @deprecated Use reloadSigningKeyFromSecretsProvider() instead
 */
export function reloadSigningKeyFromSecretsFile() {
  const filePath = readSecretsFilePath();
  if (!filePath) {
    throw new Error("SIGNING_KEY_FILE is not configured");
  }
  const secret = readSecretFromFile(filePath);
  return rotateSigningKey(secret, { source: "file_reload" });
}

/**
 * Constant-time comparison for the admin rotate token (#293).
 */
export function isAdminRotateTokenValid(providedToken) {
  const expected = normalizeSecret(process.env.ADMIN_ROTATE_TOKEN);
  if (!expected || typeof providedToken !== "string" || providedToken.length === 0) {
    return false;
  }
  const a = Buffer.from(providedToken);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Reset module state (tests only). */
export function _resetSigningKeyState() {
  activeKeypair = null;
  lastRotationAt = null;
  lastRotationSource = null;
}
