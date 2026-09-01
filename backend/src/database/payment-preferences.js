/**
 * Payment preferences database helpers.
 *
 * Stores each contributor's preferred payout method keyed by their
 * Stellar wallet address.  There is intentionally no auth layer here —
 * the wallet address itself is the identifier (same pattern used by the
 * rest of the API).
 */

import { db, countWrite } from "./core.js";

/**
 * Return the stored payment preference for `walletAddress`, or null if
 * no preference has been saved yet.
 *
 * @param {string} walletAddress  Stellar G-address
 * @returns {{ walletAddress: string, paymentMethod: string, updatedAt: string } | null}
 */
export function getPaymentPreference(walletAddress) {
  return (
    db
      .prepare(
        `SELECT walletAddress, paymentMethod, updatedAt
         FROM payment_preferences
         WHERE walletAddress = ?`
      )
      .get(walletAddress) ?? null
  );
}

/**
 * Upsert the payment preference for `walletAddress`.
 *
 * @param {string} walletAddress   Stellar G-address
 * @param {string} paymentMethod   One of: 'direct_transfer' | 'usdc' | 'xlm'
 * @returns {{ walletAddress: string, paymentMethod: string, updatedAt: string }}
 */
export function savePaymentPreference(walletAddress, paymentMethod) {
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO payment_preferences (walletAddress, paymentMethod, updatedAt)
     VALUES (?, ?, ?)
     ON CONFLICT(walletAddress)
     DO UPDATE SET paymentMethod = excluded.paymentMethod,
                   updatedAt     = excluded.updatedAt`
  ).run(walletAddress, paymentMethod, now);

  countWrite();

  return { walletAddress, paymentMethod, updatedAt: now };
}
