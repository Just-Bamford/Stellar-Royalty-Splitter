import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { keyManager } from "../services/key-manager.js";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_PREFIX = "enc:v1:";
const IV_LENGTH = 12;

function associatedData(contractId, field) {
  if (typeof contractId !== "string" || !contractId.trim()) {
    throw new Error("A contractId is required for field encryption");
  }
  if (typeof field !== "string" || !field.trim()) {
    throw new Error("A field name is required for field encryption");
  }
  return Buffer.from(`${contractId}\0${field}`, "utf8");
}

export function isEncryptedField(value) {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

export function encryptField(value, contractId, field, manager = keyManager) {
  if (value === null || value === undefined) return value;
  const version = manager.getCurrentVersion();
  const aad = associatedData(contractId, field);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, manager.getFieldKey(contractId, field, version, "encrypt"), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8")),
    cipher.final(),
  ]);
  const envelope = {
    keyVersion: version,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: ciphertext.toString("base64url"),
  };
  return `${ENVELOPE_PREFIX}${Buffer.from(JSON.stringify(envelope)).toString("base64url")}`;
}

export function decryptField(value, contractId, field, manager = keyManager) {
  if (value === null || value === undefined) return value;
  if (!isEncryptedField(value)) return value;

  const encoded = value.slice(ENVELOPE_PREFIX.length);
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Encrypted field envelope is malformed");
  }
  if (
    !Number.isSafeInteger(envelope.keyVersion) ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.data !== "string"
  ) {
    throw new Error("Encrypted field envelope is malformed");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    manager.getFieldKey(contractId, field, envelope.keyVersion, "encrypt"),
    Buffer.from(envelope.iv, "base64url"),
  );
  decipher.setAAD(associatedData(contractId, field));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Encrypted field authentication failed");
  }
}

export function fieldBlindIndex(value, contractId, field, manager = keyManager) {
  if (value === null || value === undefined) return value;
  // Keep equality indexes stable across data-key rotations; version 1 is retained in Vault.
  const version = 1;
  const key = manager.getFieldKey(contractId, field, version, "blind-index");
  const normalized = String(value);
  const digest = createHmac("sha256", key).update(normalized, "utf8").digest("hex");
  return `bi:v1:${version}:${digest}`;
}

export function timingSafeIndexEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}