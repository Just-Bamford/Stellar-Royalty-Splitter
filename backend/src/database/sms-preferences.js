/**
 * SMS notification preferences database helpers — closes #927.
 *
 * Stores each contributor's SMS opt-in and phone number, keyed by their
 * Stellar wallet address. Mirrors the pattern in
 * `src/database/notification-preferences.js`: a single upsert keyed by
 * walletAddress, merging unspecified fields against the existing row
 * rather than overwriting them.
 */

import { db, countWrite } from "./core.js";

/**
 * Return the stored SMS preferences for `walletAddress`, or null.
 *
 * @param {string} walletAddress  Stellar G-address
 * @returns {{ walletAddress: string, smsEnabled: number, phoneNumber: string|null, updatedAt: string } | null}
 */
export function getSmsPreferences(walletAddress) {
  return (
    db
      .prepare(
        `SELECT walletAddress, smsEnabled, phoneNumber, updatedAt
         FROM sms_preferences
         WHERE walletAddress = ?`
      )
      .get(walletAddress) ?? null
  );
}

/**
 * Upsert SMS preferences for `walletAddress`.
 *
 * `smsEnabled` is stored as a 0/1 integer. Omitted fields keep their
 * existing value (merge, not overwrite).
 *
 * @param {string} walletAddress
 * @param {{ smsEnabled?: boolean, phoneNumber?: string|null }} fields
 * @returns {{ walletAddress: string, smsEnabled: number, phoneNumber: string|null, updatedAt: string }}
 */
export function saveSmsPreferences(walletAddress, fields) {
  const now = new Date().toISOString();

  const existing = getSmsPreferences(walletAddress) ?? {
    smsEnabled: 0,
    phoneNumber: null,
  };

  const smsEnabled =
    fields.smsEnabled !== undefined ? (fields.smsEnabled ? 1 : 0) : existing.smsEnabled;
  const phoneNumber =
    fields.phoneNumber !== undefined ? fields.phoneNumber : existing.phoneNumber;

  db.prepare(`
    INSERT INTO sms_preferences (walletAddress, smsEnabled, phoneNumber, updatedAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(walletAddress)
    DO UPDATE SET smsEnabled  = excluded.smsEnabled,
                  phoneNumber = excluded.phoneNumber,
                  updatedAt   = excluded.updatedAt
  `).run(walletAddress, smsEnabled, phoneNumber, now);

  countWrite();

  return { walletAddress, smsEnabled, phoneNumber, updatedAt: now };
}

/**
 * Record the outcome of an SMS send attempt for delivery tracking (#927).
 *
 * Scope note: this persists only the *initial* Twilio API response status
 * (queued/sent/failed + the provider message SID or failure reason). A full
 * status-callback receiver for later delivery/bounce/opt-out events from
 * Twilio's webhook is a larger addition (a new public endpoint, signature
 * verification, and a status-transition table) and is out of scope here;
 * see the #927 implementation notes.
 *
 * @param {object} params
 * @param {string} params.walletAddress
 * @param {string} params.eventType     e.g. "large_payout" | "dispute_opened" | "payment_failed"
 * @param {string} params.phoneNumber
 * @param {boolean} params.sent
 * @param {string} [params.providerSid]
 * @param {string} [params.failureReason]
 * @returns {{ id: number|bigint }}
 */
export function recordSmsSendAttempt({
  walletAddress,
  eventType,
  phoneNumber,
  sent,
  providerSid = null,
  failureReason = null,
}) {
  const stmt = db.prepare(`
    INSERT INTO sms_send_log (walletAddress, eventType, phoneNumber, status, providerSid, failureReason)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    walletAddress,
    eventType,
    phoneNumber,
    sent ? "sent" : "failed",
    providerSid,
    failureReason
  );
  countWrite();
  return { id: result.lastInsertRowid };
}
