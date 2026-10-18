import { createHash, hkdfSync, randomBytes } from "node:crypto";

export const KEY_ROTATION_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;
const TEST_KEY = Buffer.alloc(32, 0x5a).toString("base64");

function deriveRootKey(value) {
  return createHash("sha256").update(String(value)).digest();
}

function normalizeKeyring(value) {
  if (!value || typeof value !== "object" || !value.keys || typeof value.keys !== "object") {
    throw new Error("Field encryption keyring is invalid");
  }
  const currentVersion = Number(value.currentVersion);
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
    throw new Error("Field encryption keyring has an invalid currentVersion");
  }
  const keys = {};
  for (const [version, encoded] of Object.entries(value.keys)) {
    const key = Buffer.from(encoded, "base64");
    if (!/^\d+$/.test(version) || key.length !== 32) {
      throw new Error(`Field encryption key version ${version} is invalid`);
    }
    keys[version] = key.toString("base64");
  }
  if (!keys[currentVersion]) throw new Error("Current field encryption key is missing");
  if (!keys[1]) throw new Error("Field encryption key version 1 must be retained for blind indexes");
  const rotatedAt = Date.parse(value.rotatedAt);
  if (!Number.isFinite(rotatedAt)) throw new Error("Field encryption keyring has an invalid rotatedAt");
  return { currentVersion, rotatedAt: new Date(rotatedAt).toISOString(), keys };
}

export class KeyManager {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.keyring = null;
    this.vaultCasVersion = null;
    this.rotationTimer = null;
    this.derivedKeys = new Map();
  }

  get vaultConfigured() {
    return Boolean(
      this.env.VAULT_ADDR &&
      this.env.VAULT_TOKEN &&
      this.env.FIELD_ENCRYPTION_VAULT_PATH,
    );
  }

  async initialize({ scheduleRotation = false } = {}) {
    if (this.vaultConfigured) {
      const stored = await this.readVaultKeyring();
      if (stored) {
        this.keyring = normalizeKeyring(stored.keyring);
        this.vaultCasVersion = stored.casVersion;
      } else {
        this.keyring = this.createInitialKeyring();
        try {
          this.vaultCasVersion = await this.writeVaultKeyring(this.keyring, 0);
        } catch (error) {
          const latest = await this.readVaultKeyring();
          if (!latest) throw error;
          this.keyring = normalizeKeyring(latest.keyring);
          this.vaultCasVersion = latest.casVersion;
        }
      }
      await this.rotateIfDue();
      if (scheduleRotation) this.scheduleRotation();
      return this.getStatus();
    }

    if (this.env.FIELD_ENCRYPTION_MASTER_KEY && this.env.NODE_ENV !== "production") {
      const version = Number(this.env.FIELD_ENCRYPTION_KEY_VERSION || 1);
      this.keyring = normalizeKeyring({
        currentVersion: version,
        rotatedAt: this.env.FIELD_ENCRYPTION_ROTATED_AT || new Date(this.now()).toISOString(),
        keys: { [version]: deriveRootKey(this.env.FIELD_ENCRYPTION_MASTER_KEY).toString("base64") },
      });
      return this.getStatus();
    }

    if (this.env.NODE_ENV === "test") {
      this.keyring = normalizeKeyring({
        currentVersion: 1,
        rotatedAt: new Date(this.now()).toISOString(),
        keys: { 1: TEST_KEY },
      });
      return this.getStatus();
    }

    throw new Error(
      "Configure Vault (VAULT_ADDR, VAULT_TOKEN, FIELD_ENCRYPTION_VAULT_PATH) or FIELD_ENCRYPTION_MASTER_KEY before starting the backend",
    );
  }

  createInitialKeyring() {
    return {
      currentVersion: 1,
      rotatedAt: new Date(this.now()).toISOString(),
      keys: { 1: randomBytes(32).toString("base64") },
    };
  }

  getCurrentVersion() {
    this.ensureSynchronousKeyring();
    return this.keyring.currentVersion;
  }

  getFieldKey(contractId, field, version = this.getCurrentVersion(), purpose = "encrypt") {
    this.ensureSynchronousKeyring();
    if (typeof contractId !== "string" || !contractId.trim()) {
      throw new Error("A contractId is required for field encryption");
    }
    const cacheKey = `${version}\0${contractId}\0${field}\0${purpose}`;
    const cached = this.derivedKeys.get(cacheKey);
    if (cached) return cached;
    const encoded = this.keyring.keys[version];
    if (!encoded) throw new Error(`Encryption key version ${version} is unavailable`);
    const rootKey = Buffer.from(encoded, "base64");
    const derived = Buffer.from(
      hkdfSync(
        "sha256",
        rootKey,
        Buffer.from(`srs:${contractId}`),
        Buffer.from(`field-encryption:${purpose}:${field}`),
        32,
      ),
    );
    if (this.derivedKeys.size >= 10_000) {
      const oldestKey = this.derivedKeys.keys().next().value;
      this.derivedKeys.get(oldestKey)?.fill(0);
      this.derivedKeys.delete(oldestKey);
    }
    this.derivedKeys.set(cacheKey, derived);
    return derived;
  }

  async rotate({ force = false } = {}) {
    this.ensureSynchronousKeyring();
    if (!this.vaultConfigured || this.vaultCasVersion === null) {
      throw new Error("Key rotation requires a versioned Vault keyring");
    }
    if (!force && this.now() - Date.parse(this.keyring.rotatedAt) < KEY_ROTATION_INTERVAL_MS) {
      return this.getStatus();
    }

    const currentVersion = this.keyring.currentVersion;
    const nextVersion = currentVersion + 1;
    const nextKeyring = {
      currentVersion: nextVersion,
      rotatedAt: new Date(this.now()).toISOString(),
      keys: {
        ...this.keyring.keys,
        [nextVersion]: randomBytes(32).toString("base64"),
      },
    };
    try {
      this.vaultCasVersion = await this.writeVaultKeyring(nextKeyring, this.vaultCasVersion);
      this.keyring = normalizeKeyring(nextKeyring);
    } catch (error) {
      const latest = await this.readVaultKeyring();
      if (!latest) throw error;
      this.keyring = normalizeKeyring(latest.keyring);
      this.vaultCasVersion = latest.casVersion;
      if (this.keyring.currentVersion === currentVersion) throw error;
    }
    return this.getStatus();
  }

  async rotateIfDue() {
    if (this.vaultCasVersion === null) return this.getStatus();
    if (this.now() - Date.parse(this.keyring.rotatedAt) >= KEY_ROTATION_INTERVAL_MS) {
      return this.rotate({ force: true });
    }
    return this.getStatus();
  }

  getStatus() {
    if (!this.keyring) return { initialized: false };
    return {
      initialized: true,
      currentVersion: this.keyring.currentVersion,
      rotatedAt: this.keyring.rotatedAt,
      vaultBacked: this.vaultConfigured,
    };
  }

  scheduleRotation() {
    if (this.rotationTimer) return;
    this.rotationTimer = setInterval(() => {
      this.refreshFromVault().then(() => this.rotateIfDue()).catch((error) => {
        console.error("Field encryption key rotation failed:", error.message);
      });
    }, 60 * 60 * 1000);
    this.rotationTimer.unref?.();
  }

  async refreshFromVault() {
    if (!this.vaultConfigured) return this.getStatus();
    const latest = await this.readVaultKeyring();
    if (!latest) throw new Error("Vault field encryption keyring disappeared");
    const nextKeyring = normalizeKeyring(latest.keyring);
    if (nextKeyring.currentVersion >= (this.keyring?.currentVersion ?? 0)) {
      this.keyring = nextKeyring;
      this.vaultCasVersion = latest.casVersion;
    }
    return this.getStatus();
  }

  ensureSynchronousKeyring() {
    if (this.keyring) return;
    if (this.env.NODE_ENV === "test") {
      this.keyring = normalizeKeyring({
        currentVersion: 1,
        rotatedAt: new Date(this.now()).toISOString(),
        keys: { 1: TEST_KEY },
      });
      return;
    }
    if (this.env.FIELD_ENCRYPTION_MASTER_KEY && this.env.NODE_ENV !== "production") {
      const version = Number(this.env.FIELD_ENCRYPTION_KEY_VERSION || 1);
      this.keyring = normalizeKeyring({
        currentVersion: version,
        rotatedAt: this.env.FIELD_ENCRYPTION_ROTATED_AT || new Date(this.now()).toISOString(),
        keys: { [version]: deriveRootKey(this.env.FIELD_ENCRYPTION_MASTER_KEY).toString("base64") },
      });
      return;
    }
    throw new Error("Field encryption keyring has not been initialized");
  }

  async readVaultKeyring() {
    const response = await this.fetchImpl(this.vaultUrl(), {
      headers: { "X-Vault-Token": this.env.VAULT_TOKEN },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Vault key read failed (${response.status})`);
    const body = await response.json();
    const keyring = body.data?.data ?? body.data;
    const casVersion = body.data?.metadata?.version ?? body.data?.version ?? null;
    if (casVersion === null) throw new Error("Vault keyring response is missing its version");
    return { keyring, casVersion };
  }

  async writeVaultKeyring(keyring, casVersion) {
    const response = await this.fetchImpl(this.vaultUrl(), {
      method: "POST",
      headers: {
        "X-Vault-Token": this.env.VAULT_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: keyring, options: { cas: casVersion } }),
    });
    if (!response.ok) throw new Error(`Vault key write failed (${response.status})`);
    const body = await response.json().catch(() => ({}));
    return body.data?.version ?? casVersion + 1;
  }

  vaultUrl() {
    const address = this.env.VAULT_ADDR.replace(/\/+$/, "");
    const secretPath = this.env.FIELD_ENCRYPTION_VAULT_PATH.replace(/^\/+/, "");
    return `${address}/v1/${secretPath}`;
  }
}

export const keyManager = new KeyManager();

export async function initializeKeyManager(options) {
  return keyManager.initialize(options);
}