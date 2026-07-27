/**
 * Two-factor authentication persistence (#578).
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { db, countWrite } from "./core.js";
import { encryptSecret, decryptSecret } from "../secrets-manager.js";
import { hashBackupCode, normalizeBackupCode } from "../services/totp.js";

function ensureUser(walletAddress, role = "admin") {
  const existing = db
    .prepare("SELECT id, role FROM users WHERE walletAddress = ?")
    .get(walletAddress);

  if (existing) return existing;

  const result = db
    .prepare("INSERT INTO users (walletAddress, role) VALUES (?, ?)")
    .run(walletAddress, role);
  countWrite();
  return { id: Number(result?.lastInsertRowid ?? 0), role };
}

export function getUserByWallet(walletAddress) {
  return db
    .prepare("SELECT id, walletAddress, role, active FROM users WHERE walletAddress = ?")
    .get(walletAddress);
}

export function getTwoFactorRecord(walletAddress) {
  return db
    .prepare(
      `SELECT tf.*
       FROM user_2fa tf
       JOIN users u ON u.id = tf.userId
       WHERE u.walletAddress = ?`,
    )
    .get(walletAddress);
}

export function getTwoFactorStatus(walletAddress) {
  const user = getUserByWallet(walletAddress);
  const record = getTwoFactorRecord(walletAddress);
  return {
    walletAddress,
    role: user?.role ?? null,
    enabled: Boolean(record?.enabled),
    pending: Boolean(record && !record.enabled),
    verifiedSessionRequired: Boolean(user?.role === "admin" && record?.enabled),
  };
}

export function beginTwoFactorSetup(walletAddress, secret, backupCodes) {
  const user = ensureUser(walletAddress, "admin");
  const encrypted = encryptSecret(secret);
  const secretPayload = JSON.stringify(encrypted);

  const existing = getTwoFactorRecord(walletAddress);
  if (existing?.enabled) {
    const err = new Error("2FA is already enabled");
    err.status = 409;
    err.code = "two_factor_already_enabled";
    throw err;
  }

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE user_2fa
         SET secretEncrypted = ?, enabled = 0, confirmedAt = NULL, updatedAt = CURRENT_TIMESTAMP
         WHERE userId = ?`,
      ).run(secretPayload, user.id);
      db.prepare("DELETE FROM user_2fa_backup_codes WHERE userId = ?").run(user.id);
    } else {
      db.prepare(
        `INSERT INTO user_2fa (userId, secretEncrypted, enabled)
         VALUES (?, ?, 0)`,
      ).run(user.id, secretPayload);
    }

    const insertCode = db.prepare(
      `INSERT INTO user_2fa_backup_codes (userId, codeHash) VALUES (?, ?)`,
    );
    for (const code of backupCodes) {
      insertCode.run(user.id, hashBackupCode(code));
    }
  });

  tx();
  countWrite();
  return { userId: user.id };
}

export function confirmTwoFactorSetup(walletAddress) {
  const record = getTwoFactorRecord(walletAddress);
  if (!record) {
    const err = new Error("2FA setup not started");
    err.status = 404;
    err.code = "two_factor_not_found";
    throw err;
  }

  db.prepare(
    `UPDATE user_2fa
     SET enabled = 1, confirmedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(record.id);
  countWrite();
}

export function decryptTwoFactorSecret(walletAddress) {
  const record = getTwoFactorRecord(walletAddress);
  if (!record) return null;
  const payload = JSON.parse(record.secretEncrypted);
  return decryptSecret(payload);
}

export function consumeBackupCode(walletAddress, backupCode) {
  const user = getUserByWallet(walletAddress);
  if (!user) return false;

  const codes = db
    .prepare(
      `SELECT id, codeHash FROM user_2fa_backup_codes
       WHERE userId = ? AND usedAt IS NULL`,
    )
    .all(user.id);

  const normalized = normalizeBackupCode(backupCode);
  const candidateHash = hashBackupCode(normalized);

  for (const row of codes) {
    const a = Buffer.from(row.codeHash);
    const b = Buffer.from(candidateHash);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      db.prepare(
        `UPDATE user_2fa_backup_codes SET usedAt = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(row.id);
      countWrite();
      return true;
    }
  }
  return false;
}

export function disableTwoFactor(walletAddress) {
  const user = getUserByWallet(walletAddress);
  if (!user) return false;

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM user_2fa_backup_codes WHERE userId = ?").run(user.id);
    db.prepare("DELETE FROM user_2fa_sessions WHERE userId = ?").run(user.id);
    db.prepare("DELETE FROM user_2fa WHERE userId = ?").run(user.id);
  });
  tx();
  countWrite();
  return true;
}

export function createVerifiedSession(walletAddress, ttlMinutes = 60) {
  const user = getUserByWallet(walletAddress);
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    err.code = "user_not_found";
    throw err;
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();

  db.prepare(
    `INSERT INTO user_2fa_sessions (userId, tokenHash, expiresAt)
     VALUES (?, ?, ?)`,
  ).run(user.id, tokenHash, expiresAt);
  countWrite();

  return { token, expiresAt };
}

export function isSessionValid(walletAddress, token) {
  if (!token) return false;
  const user = getUserByWallet(walletAddress);
  if (!user) return false;

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const row = db
    .prepare(
      `SELECT id FROM user_2fa_sessions
       WHERE userId = ? AND tokenHash = ? AND expiresAt > CURRENT_TIMESTAMP`,
    )
    .get(user.id, tokenHash);

  return Boolean(row);
}

export function revokeSessions(walletAddress) {
  const user = getUserByWallet(walletAddress);
  if (!user) return;
  db.prepare("DELETE FROM user_2fa_sessions WHERE userId = ?").run(user.id);
  countWrite();
}
