/**
 * Contributor notification preferences database helpers — closes #605.
 *
 * Stores each contributor's per-channel notification opt-in/opt-out keyed
 * by their Stellar wallet address.  Channels: email, sms, in_app, push.
 */

import { db, countWrite } from "./core.js";

/**
 * Return the stored notification preferences for `walletAddress`, or null.
 *
 * @param {string} walletAddress  Stellar G-address
 * @returns {{ walletAddress: string, email: number, sms: number, inApp: number, push: number, updatedAt: string } | null}
 */
export function getNotificationPreferences(walletAddress) {
  return (
    db
      .prepare(
        `SELECT walletAddress, email, sms, inApp, push, updatedAt
         FROM notification_preferences
         WHERE walletAddress = ?`
      )
      .get(walletAddress) ?? null
  );
}

/**
 * Upsert notification preferences for `walletAddress`.
 *
 * All channel values are booleans stored as 0/1 integers.
 * Omitted channels keep their existing value via the COALESCE pattern.
 *
 * @param {string} walletAddress
 * @param {{ email?: boolean, sms?: boolean, inApp?: boolean, push?: boolean }} channels
 * @returns {{ walletAddress: string, email: number, sms: number, inApp: number, push: number, updatedAt: string }}
 */
export function saveNotificationPreferences(walletAddress, channels) {
  const now = new Date().toISOString();

  // Fetch existing row so we can merge rather than overwrite unspecified channels.
  const existing = getNotificationPreferences(walletAddress) ?? {
    email: 1,
    sms: 0,
    inApp: 1,
    push: 0,
  };

  const email  = channels.email  !== undefined ? (channels.email  ? 1 : 0) : existing.email;
  const sms    = channels.sms    !== undefined ? (channels.sms    ? 1 : 0) : existing.sms;
  const inApp  = channels.inApp  !== undefined ? (channels.inApp  ? 1 : 0) : existing.inApp;
  const push   = channels.push   !== undefined ? (channels.push   ? 1 : 0) : existing.push;

  db.prepare(`
    INSERT INTO notification_preferences (walletAddress, email, sms, inApp, push, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(walletAddress)
    DO UPDATE SET email     = excluded.email,
                  sms       = excluded.sms,
                  inApp     = excluded.inApp,
                  push      = excluded.push,
                  updatedAt = excluded.updatedAt
  `).run(walletAddress, email, sms, inApp, push, now);

  countWrite();

  return { walletAddress, email, sms, inApp, push, updatedAt: now };
}
