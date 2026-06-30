/**
 * Admin-issued API keys for per-key rate limiting (#420).
 *
 * The raw key is only ever returned once, at creation time. Only its
 * SHA-256 hash is persisted, the same approach idempotency.js uses for
 * content hashing.
 */

import crypto from "crypto";
import { db, countWrite } from "./core.js";

function hashKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey, "utf8").digest("hex");
}

function generateRawKey() {
  return `srs_${crypto.randomBytes(32).toString("base64url")}`;
}

/**
 * Generate and store a new API key. Returns the raw key — callers must
 * surface it to the operator immediately, since it can never be retrieved
 * again (only its hash is stored).
 */
export function createApiKey(label) {
  const apiKey = generateRawKey();
  const keyHash = hashKey(apiKey);

  const result = db
    .prepare(`INSERT INTO api_keys (keyHash, label) VALUES (?, ?)`)
    .run(keyHash, label ?? null);
  countWrite();

  const row = db
    .prepare(`SELECT id, label, createdAt FROM api_keys WHERE id = ?`)
    .get(result.lastInsertRowid);

  return { ...row, apiKey };
}

/** List all API keys — never includes the hash or raw key. */
export function listApiKeys() {
  return db
    .prepare(
      `SELECT id, label, createdAt, revokedAt, lastUsedAt FROM api_keys ORDER BY createdAt DESC`
    )
    .all();
}

/** Revoke an API key by id. Returns true if a row was updated. */
export function revokeApiKey(id) {
  const result = db
    .prepare(`UPDATE api_keys SET revokedAt = CURRENT_TIMESTAMP WHERE id = ? AND revokedAt IS NULL`)
    .run(id);
  countWrite();
  return result.changes > 0;
}

/**
 * Resolve a raw API key (e.g. from the X-API-Key header) to its active
 * (non-revoked) row, updating lastUsedAt. Returns null if the key is
 * unknown or revoked.
 */
export function findActiveKeyByRawKey(rawKey) {
  const keyHash = hashKey(rawKey);
  const row = db
    .prepare(`SELECT id, label FROM api_keys WHERE keyHash = ? AND revokedAt IS NULL`)
    .get(keyHash);

  if (!row) return null;

  db.prepare(`UPDATE api_keys SET lastUsedAt = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
  countWrite();

  return row;
}
