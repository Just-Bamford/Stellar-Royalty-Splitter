/**
 * KYC (Know Your Customer) integration hooks — closes #598.
 *
 * Stores KYC events received from external providers (Veriff, Jumio).
 * Links to contributor_verification to update wallet verification_status
 * automatically on callback receipt.
 */

import { db, countWrite } from "./core.js";

export const KYC_PROVIDERS = /** @type {const} */ (["veriff", "jumio"]);

export const KYC_EVENT_OUTCOMES = /** @type {const} */ ([
  "approved",
  "declined",
  "resubmission_requested",
  "expired",
  "abandoned",
]);

/**
 * Persist a raw KYC callback event.
 *
 * @param {object} params
 * @param {string} params.provider         - "veriff" | "jumio"
 * @param {string} params.providerSessionId - Provider's session/verification ID
 * @param {string} params.walletAddress     - Contributor wallet (may be null if not yet resolved)
 * @param {string} params.outcome           - One of KYC_EVENT_OUTCOMES
 * @param {string} params.rawPayload        - Full JSON payload as string
 * @returns {number} Inserted row id
 */
export function recordKycEvent({ provider, providerSessionId, walletAddress, outcome, rawPayload }) {
  const result = db.prepare(`
    INSERT INTO kyc_events
      (provider, providerSessionId, walletAddress, outcome, rawPayload, receivedAt)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(provider, providerSessionId, walletAddress ?? null, outcome, rawPayload);

  countWrite();
  return result.lastInsertRowid;
}

/**
 * Retrieve a KYC event by its provider session ID.
 *
 * @param {string} provider
 * @param {string} providerSessionId
 * @returns {object|null}
 */
export function getKycEventBySession(provider, providerSessionId) {
  return db.prepare(`
    SELECT id, provider, providerSessionId, walletAddress, outcome, rawPayload, receivedAt
    FROM kyc_events
    WHERE provider = ? AND providerSessionId = ?
    ORDER BY receivedAt DESC
    LIMIT 1
  `).get(provider, providerSessionId) ?? null;
}

/**
 * List all KYC events for a wallet address (most recent first).
 *
 * @param {string} walletAddress
 * @param {number} limit
 * @param {number} offset
 * @returns {object[]}
 */
export function getKycEventsByWallet(walletAddress, limit = 50, offset = 0) {
  return db.prepare(`
    SELECT id, provider, providerSessionId, walletAddress, outcome, rawPayload, receivedAt
    FROM kyc_events
    WHERE walletAddress = ?
    ORDER BY receivedAt DESC
    LIMIT ? OFFSET ?
  `).all(walletAddress, limit, offset);
}

/**
 * Count KYC events for a wallet.
 *
 * @param {string} walletAddress
 * @returns {number}
 */
export function countKycEventsByWallet(walletAddress) {
  return db.prepare(`
    SELECT COUNT(*) as total FROM kyc_events WHERE walletAddress = ?
  `).get(walletAddress)?.total ?? 0;
}

/**
 * Link a provider session ID to a wallet address (used when the wallet
 * is resolved after the initial session is created).
 *
 * @param {string} provider
 * @param {string} providerSessionId
 * @param {string} walletAddress
 */
export function linkKycSessionToWallet(provider, providerSessionId, walletAddress) {
  db.prepare(`
    UPDATE kyc_events
    SET walletAddress = ?
    WHERE provider = ? AND providerSessionId = ?
  `).run(walletAddress, provider, providerSessionId);
  countWrite();
}
