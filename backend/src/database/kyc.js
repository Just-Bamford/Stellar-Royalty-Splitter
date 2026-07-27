/**
 * KYC (Know Your Customer) database functions (#598).
 * Stores verification status and event logs for contributors.
 */

import { db, countWrite } from "./core.js";

/**
 * Upsert the KYC verification status for a contributor.
 * @param {string} walletAddress - Stellar wallet address
 * @param {string} verificationStatus - 'pending'|'verified'|'rejected'|'expired'
 * @param {string} provider - KYC provider name ('veriff'|'jumio'|'manual')
 * @param {string|null} providerSessionId - Provider-side session/verification ID
 * @returns {object} Updated KYC record
 */
export function upsertKycStatus(walletAddress, verificationStatus, provider, providerSessionId = null) {
  const existing = db
    .prepare("SELECT id FROM contributor_kyc WHERE walletAddress = ?")
    .get(walletAddress);

  if (existing) {
    db.prepare(`
      UPDATE contributor_kyc
      SET verification_status = ?,
          provider = ?,
          provider_session_id = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE walletAddress = ?
    `).run(verificationStatus, provider, providerSessionId, walletAddress);
  } else {
    db.prepare(`
      INSERT INTO contributor_kyc (walletAddress, verification_status, provider, provider_session_id)
      VALUES (?, ?, ?, ?)
    `).run(walletAddress, verificationStatus, provider, providerSessionId);
  }
  countWrite();

  return getKycStatus(walletAddress);
}

/**
 * Get the KYC record for a wallet address.
 */
export function getKycStatus(walletAddress) {
  return db
    .prepare("SELECT * FROM contributor_kyc WHERE walletAddress = ?")
    .get(walletAddress) ?? null;
}

/**
 * Log a raw KYC webhook event for audit purposes.
 * @param {string} provider - KYC provider ('veriff'|'jumio')
 * @param {string} eventType - Provider-specific event type string
 * @param {string|null} walletAddress - Resolved wallet address (may be null if lookup fails)
 * @param {string} rawPayload - JSON stringified raw webhook payload
 * @param {string} resolvedStatus - Mapped internal status
 * @returns {number} Inserted row ID
 */
export function logKycEvent(provider, eventType, walletAddress, rawPayload, resolvedStatus) {
  const result = db.prepare(`
    INSERT INTO kyc_events (provider, event_type, walletAddress, raw_payload, resolved_status)
    VALUES (?, ?, ?, ?, ?)
  `).run(provider, eventType, walletAddress, rawPayload, resolvedStatus);
  countWrite();
  return result.lastInsertRowid;
}

/**
 * Get KYC event log for a wallet address, most recent first.
 */
export function getKycEvents(walletAddress, limit = 50) {
  return db
    .prepare(
      "SELECT * FROM kyc_events WHERE walletAddress = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(walletAddress, limit);
}

/**
 * Get all KYC events for audit review, newest first.
 */
export function getAllKycEvents(limit = 100, offset = 0) {
  return db
    .prepare(
      "SELECT * FROM kyc_events ORDER BY created_at DESC LIMIT ? OFFSET ?"
    )
    .all(limit, offset);
}
