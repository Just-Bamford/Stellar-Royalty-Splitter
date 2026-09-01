/**
 * Secrets manager integration for loading encrypted signing keys.
 *
 * Supports:
 * - AWS Secrets Manager
 * - HashiCorp Vault
 * - Plaintext file fallback (for local development)
 * - Environment variable fallback
 *
 * Configuration:
 * - SECRETS_PROVIDER: "aws" | "vault" | "file" | "env" (default: auto-detect)
 * - AWS_SECRET_NAME: Name of the secret in AWS Secrets Manager
 * - AWS_REGION: AWS region (default: us-east-1)
 * - VAULT_ADDR: HashiCorp Vault address (e.g., https://vault.example.com:8200)
 * - VAULT_TOKEN: Vault authentication token
 * - VAULT_SECRET_PATH: Path to secret in Vault (e.g., secret/data/signing-key)
 * - SIGNING_KEY_FILE: Path to plaintext file (fallback for local dev)
 * - SERVER_SECRET_KEY: Plaintext env var (fallback for local dev)
 */

import { readFileSync, existsSync } from "fs";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";
import logger from "./logger.js";

// Encryption configuration for at-rest encryption
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENCRYPTION_KEY_ENV = "SECRETS_ENCRYPTION_KEY";

/**
 * Get or generate encryption key for at-rest encryption.
 * In production, this should be loaded from a secure key management system.
 */
function getEncryptionKey() {
  const envKey = process.env[ENCRYPTION_KEY_ENV];
  if (envKey) {
    // Derive 32-byte key from provided key using SHA-256
    return createHash("sha256").update(envKey).digest();
  }

  // For development: generate ephemeral key (not persisted)
  logger.warn("No SECRETS_ENCRYPTION_KEY configured, using ephemeral key (dev only)", {
    event: "secrets_ephemeral_key",
  });
  return randomBytes(32);
}

/**
 * Encrypt secret data at rest using AES-256-GCM.
 */
export function encryptSecret(plaintext) {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    algorithm: ENCRYPTION_ALGORITHM,
  };
}

/**
 * Decrypt secret data using AES-256-GCM.
 */
export function decryptSecret(encryptedData) {
  const key = getEncryptionKey();
  const decipher = createDecipheriv(
    ENCRYPTION_ALGORITHM,
    key,
    Buffer.from(encryptedData.iv, "hex")
  );

  decipher.setAuthTag(Buffer.from(encryptedData.authTag, "hex"));

  let decrypted = decipher.update(encryptedData.encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Load secret from AWS Secrets Manager.
 * Requires AWS SDK to be installed: npm install @aws-sdk/client-secrets-manager
 */
async function loadFromAWS() {
  const secretName = process.env.AWS_SECRET_NAME;
  const region = process.env.AWS_REGION || "us-east-1";

  if (!secretName) {
    throw new Error("AWS_SECRET_NAME is required when using AWS Secrets Manager");
  }

  try {
    // Dynamic import to avoid requiring AWS SDK when not using AWS
    const { SecretsManagerClient, GetSecretValueCommand } = await import(
      "@aws-sdk/client-secrets-manager"
    );

    const client = new SecretsManagerClient({ region });
    const command = new GetSecretValueCommand({ SecretId: secretName });
    const response = await client.send(command);

    let secret;
    if (response.SecretString) {
      // Secret is stored as string
      const parsed = JSON.parse(response.SecretString);
      secret = parsed.signingKey || parsed.SECRET_KEY || parsed.key;
    } else if (response.SecretBinary) {
      // Secret is stored as binary
      secret = Buffer.from(response.SecretBinary).toString("utf8");
    }

    if (!secret) {
      throw new Error("Secret key not found in AWS Secrets Manager response");
    }

    logger.info("Signing key loaded from AWS Secrets Manager", {
      event: "secrets_loaded",
      provider: "aws",
      secretName,
      region,
    });

    return secret;
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") {
      throw new Error(
        "AWS SDK not installed. Run: npm install @aws-sdk/client-secrets-manager"
      );
    }
    logger.error("Failed to load secret from AWS Secrets Manager", {
      event: "secrets_load_failed",
      provider: "aws",
      error: error.message,
    });
    throw error;
  }
}

/**
 * Load secret from HashiCorp Vault.
 * Uses HTTP API, no additional dependencies required.
 */
async function loadFromVault() {
  const vaultAddr = process.env.VAULT_ADDR;
  const vaultToken = process.env.VAULT_TOKEN;
  const secretPath = process.env.VAULT_SECRET_PATH;

  if (!vaultAddr) {
    throw new Error("VAULT_ADDR is required when using HashiCorp Vault");
  }
  if (!vaultToken) {
    throw new Error("VAULT_TOKEN is required when using HashiCorp Vault");
  }
  if (!secretPath) {
    throw new Error("VAULT_SECRET_PATH is required when using HashiCorp Vault");
  }

  try {
    const url = `${vaultAddr}/v1/${secretPath}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Vault-Token": vaultToken,
      },
    });

    if (!response.ok) {
      throw new Error(`Vault API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    // Handle both KV v1 and v2 formats
    const secretData = data.data?.data || data.data;
    const secret = secretData?.signingKey || secretData?.SECRET_KEY || secretData?.key;

    if (!secret) {
      throw new Error("Secret key not found in Vault response");
    }

    logger.info("Signing key loaded from HashiCorp Vault", {
      event: "secrets_loaded",
      provider: "vault",
      secretPath,
    });

    return secret;
  } catch (error) {
    logger.error("Failed to load secret from HashiCorp Vault", {
      event: "secrets_load_failed",
      provider: "vault",
      error: error.message,
    });
    throw error;
  }
}

/**
 * Load secret from plaintext file (for local development).
 */
function loadFromFile() {
  const filePath = process.env.SIGNING_KEY_FILE;

  if (!filePath) {
    throw new Error("SIGNING_KEY_FILE is required when using file provider");
  }

  if (!existsSync(filePath)) {
    throw new Error(`Signing key file not found: ${filePath}`);
  }

  const contents = readFileSync(filePath, "utf8").trim();

  logger.info("Signing key loaded from file", {
    event: "secrets_loaded",
    provider: "file",
    filePath,
  });

  return contents;
}

/**
 * Load secret from environment variable (for local development).
 */
function loadFromEnv() {
  const secret = process.env.SERVER_SECRET_KEY;

  if (!secret) {
    throw new Error("SERVER_SECRET_KEY is required when using env provider");
  }

  logger.info("Signing key loaded from environment variable", {
    event: "secrets_loaded",
    provider: "env",
  });

  return secret.trim();
}

/**
 * Auto-detect secrets provider based on environment configuration.
 */
function detectProvider() {
  if (process.env.AWS_SECRET_NAME) {
    return "aws";
  }
  if (process.env.VAULT_ADDR && process.env.VAULT_TOKEN) {
    return "vault";
  }
  if (process.env.SIGNING_KEY_FILE) {
    return "file";
  }
  if (process.env.SERVER_SECRET_KEY) {
    return "env";
  }
  return null;
}

/**
 * Load signing key from configured secrets provider.
 *
 * Provider priority (when SECRETS_PROVIDER is not set):
 * 1. AWS Secrets Manager (if AWS_SECRET_NAME is set)
 * 2. HashiCorp Vault (if VAULT_ADDR and VAULT_TOKEN are set)
 * 3. File (if SIGNING_KEY_FILE is set)
 * 4. Environment variable (if SERVER_SECRET_KEY is set)
 *
 * @returns {Promise<string>} The signing key secret
 */
export async function loadSigningSecret() {
  const explicitProvider = process.env.SECRETS_PROVIDER;
  const provider = explicitProvider || detectProvider();

  if (!provider) {
    logger.warn("No secrets provider configured", {
      event: "secrets_unconfigured",
    });
    return null;
  }

  logger.info("Loading signing key from secrets provider", {
    event: "secrets_loading",
    provider,
    explicit: !!explicitProvider,
  });

  try {
    let secret;

    switch (provider) {
      case "aws":
        secret = await loadFromAWS();
        break;
      case "vault":
        secret = await loadFromVault();
        break;
      case "file":
        secret = loadFromFile();
        break;
      case "env":
        secret = loadFromEnv();
        break;
      default:
        throw new Error(`Unknown secrets provider: ${provider}`);
    }

    return secret;
  } catch (error) {
    logger.error("Failed to load signing secret", {
      event: "secrets_load_error",
      provider,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Get secrets provider configuration status.
 */
export function getSecretsProviderStatus() {
  const explicitProvider = process.env.SECRETS_PROVIDER;
  const detectedProvider = detectProvider();

  return {
    configured: !!detectedProvider,
    provider: explicitProvider || detectedProvider || "none",
    explicit: !!explicitProvider,
    encryptionKeyConfigured: !!process.env[ENCRYPTION_KEY_ENV],
    availableProviders: {
      aws: !!process.env.AWS_SECRET_NAME,
      vault: !!(process.env.VAULT_ADDR && process.env.VAULT_TOKEN),
      file: !!process.env.SIGNING_KEY_FILE,
      env: !!process.env.SERVER_SECRET_KEY,
    },
  };
}

