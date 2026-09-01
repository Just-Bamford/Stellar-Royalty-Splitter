import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import {
  encryptSecret,
  decryptSecret,
  loadSigningSecret,
  getSecretsProviderStatus,
} from "../src/secrets-manager.js";

describe("Secrets encryption", () => {
  const originalEnv = process.env.SECRETS_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalEnv) {
      process.env.SECRETS_ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.SECRETS_ENCRYPTION_KEY;
    }
  });

  test("encrypts and decrypts secret correctly", () => {
    process.env.SECRETS_ENCRYPTION_KEY = "test-encryption-key-32-characters";

    const plaintext = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const encrypted = encryptSecret(plaintext);

    expect(encrypted).toHaveProperty("encrypted");
    expect(encrypted).toHaveProperty("iv");
    expect(encrypted).toHaveProperty("authTag");
    expect(encrypted.algorithm).toBe("aes-256-gcm");

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  test("encrypted data is different from plaintext", () => {
    process.env.SECRETS_ENCRYPTION_KEY = "test-encryption-key-32-characters";

    const plaintext = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const encrypted = encryptSecret(plaintext);

    expect(encrypted.encrypted).not.toBe(plaintext);
    expect(encrypted.encrypted).not.toContain(plaintext);
  });

  test("different encryptions produce different ciphertexts", () => {
    process.env.SECRETS_ENCRYPTION_KEY = "test-encryption-key-32-characters";

    const plaintext = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const encrypted1 = encryptSecret(plaintext);
    const encrypted2 = encryptSecret(plaintext);

    // Different IVs mean different ciphertexts
    expect(encrypted1.iv).not.toBe(encrypted2.iv);
    expect(encrypted1.encrypted).not.toBe(encrypted2.encrypted);

    // But both decrypt to the same plaintext
    expect(decryptSecret(encrypted1)).toBe(plaintext);
    expect(decryptSecret(encrypted2)).toBe(plaintext);
  });

  test("decryption fails with wrong auth tag", () => {
    process.env.SECRETS_ENCRYPTION_KEY = "test-encryption-key-32-characters";

    const plaintext = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const encrypted = encryptSecret(plaintext);

    // Tamper with auth tag
    encrypted.authTag = "0".repeat(32);

    expect(() => decryptSecret(encrypted)).toThrow();
  });

  test("decryption fails with wrong encryption key", () => {
    process.env.SECRETS_ENCRYPTION_KEY = "test-encryption-key-32-characters";

    const plaintext = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const encrypted = encryptSecret(plaintext);

    // Change encryption key
    process.env.SECRETS_ENCRYPTION_KEY = "different-key-32-characters-long";

    expect(() => decryptSecret(encrypted)).toThrow();
  });
});

describe("Secrets provider detection", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all secrets-related env vars
    delete process.env.SECRETS_PROVIDER;
    delete process.env.AWS_SECRET_NAME;
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
    delete process.env.SIGNING_KEY_FILE;
    delete process.env.SERVER_SECRET_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("detects AWS provider when AWS_SECRET_NAME is set", () => {
    process.env.AWS_SECRET_NAME = "my-secret";

    const status = getSecretsProviderStatus();
    expect(status.provider).toBe("aws");
    expect(status.configured).toBe(true);
    expect(status.availableProviders.aws).toBe(true);
  });

  test("detects Vault provider when VAULT_ADDR and VAULT_TOKEN are set", () => {
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_TOKEN = "hvs.token";

    const status = getSecretsProviderStatus();
    expect(status.provider).toBe("vault");
    expect(status.configured).toBe(true);
    expect(status.availableProviders.vault).toBe(true);
  });

  test("detects file provider when SIGNING_KEY_FILE is set", () => {
    process.env.SIGNING_KEY_FILE = "/path/to/key";

    const status = getSecretsProviderStatus();
    expect(status.provider).toBe("file");
    expect(status.configured).toBe(true);
    expect(status.availableProviders.file).toBe(true);
  });

  test("detects env provider when SERVER_SECRET_KEY is set", () => {
    process.env.SERVER_SECRET_KEY = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    const status = getSecretsProviderStatus();
    expect(status.provider).toBe("env");
    expect(status.configured).toBe(true);
    expect(status.availableProviders.env).toBe(true);
  });

  test("respects explicit SECRETS_PROVIDER setting", () => {
    process.env.SECRETS_PROVIDER = "vault";
    process.env.AWS_SECRET_NAME = "my-secret"; // AWS is available but not used

    const status = getSecretsProviderStatus();
    expect(status.provider).toBe("vault");
    expect(status.explicit).toBe(true);
  });

  test("returns none when no provider is configured", () => {
    const status = getSecretsProviderStatus();
    expect(status.provider).toBe("none");
    expect(status.configured).toBe(false);
  });

  test("prioritizes AWS over Vault when both are configured", () => {
    process.env.AWS_SECRET_NAME = "my-secret";
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_TOKEN = "hvs.token";

    const status = getSecretsProviderStatus();
    expect(status.provider).toBe("aws");
  });

  test("reports encryption key configuration status", () => {
    process.env.SECRETS_ENCRYPTION_KEY = "my-encryption-key";
    process.env.SERVER_SECRET_KEY = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    const status = getSecretsProviderStatus();
    expect(status.encryptionKeyConfigured).toBe(true);
  });
});

describe("Load signing secret from env", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SECRETS_PROVIDER;
    delete process.env.AWS_SECRET_NAME;
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
    delete process.env.SIGNING_KEY_FILE;
    delete process.env.SERVER_SECRET_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("loads secret from SERVER_SECRET_KEY", async () => {
    const testSecret = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    process.env.SERVER_SECRET_KEY = testSecret;

    const secret = await loadSigningSecret();
    expect(secret).toBe(testSecret);
  });

  test("trims whitespace from env secret", async () => {
    const testSecret = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    process.env.SERVER_SECRET_KEY = `  ${testSecret}  \n`;

    const secret = await loadSigningSecret();
    expect(secret).toBe(testSecret);
  });

  test("returns null when no provider is configured", async () => {
    const secret = await loadSigningSecret();
    expect(secret).toBeNull();
  });

  test("throws error when explicit provider is set but not configured", async () => {
    process.env.SECRETS_PROVIDER = "aws";
    // AWS_SECRET_NAME not set

    await expect(loadSigningSecret()).rejects.toThrow("AWS_SECRET_NAME is required");
  });
});

describe("Load signing secret from file", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SECRETS_PROVIDER;
    delete process.env.AWS_SECRET_NAME;
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
    delete process.env.SIGNING_KEY_FILE;
    delete process.env.SERVER_SECRET_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("throws error when file does not exist", async () => {
    process.env.SIGNING_KEY_FILE = "/nonexistent/path/to/key";

    await expect(loadSigningSecret()).rejects.toThrow("Signing key file not found");
  });
});

describe("Vault provider validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SECRETS_PROVIDER;
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
    delete process.env.VAULT_SECRET_PATH;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("throws error when VAULT_ADDR is missing", async () => {
    process.env.SECRETS_PROVIDER = "vault";
    process.env.VAULT_TOKEN = "hvs.token";
    process.env.VAULT_SECRET_PATH = "secret/data/key";

    await expect(loadSigningSecret()).rejects.toThrow("VAULT_ADDR is required");
  });

  test("throws error when VAULT_TOKEN is missing", async () => {
    process.env.SECRETS_PROVIDER = "vault";
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_SECRET_PATH = "secret/data/key";

    await expect(loadSigningSecret()).rejects.toThrow("VAULT_TOKEN is required");
  });

  test("throws error when VAULT_SECRET_PATH is missing", async () => {
    process.env.SECRETS_PROVIDER = "vault";
    process.env.VAULT_ADDR = "https://vault.example.com";
    process.env.VAULT_TOKEN = "hvs.token";

    await expect(loadSigningSecret()).rejects.toThrow("VAULT_SECRET_PATH is required");
  });
});

describe("AWS provider validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SECRETS_PROVIDER;
    delete process.env.AWS_SECRET_NAME;
    delete process.env.AWS_REGION;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("throws error when AWS_SECRET_NAME is missing", async () => {
    process.env.SECRETS_PROVIDER = "aws";

    await expect(loadSigningSecret()).rejects.toThrow("AWS_SECRET_NAME is required");
  });

  test("uses default region when AWS_REGION is not set", () => {
    process.env.AWS_SECRET_NAME = "my-secret";
    // AWS_REGION not set, should default to us-east-1

    const status = getSecretsProviderStatus();
    expect(status.availableProviders.aws).toBe(true);
  });
});

