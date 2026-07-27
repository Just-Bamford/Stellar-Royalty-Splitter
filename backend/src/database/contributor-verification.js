/**
 * Contributor verification database helpers — closes #602.
 *
 * Tracks multi-step verification state: email → kyc → manual_review → verified.
 * Each row is keyed by walletAddress and stores the current step, status, and
 * an optional admin note for manual-review decisions.
 */

import { db, countWrite } from "./core.js";

export const VERIFICATION_STEPS = /** @type {const} */ ([
  "email",
  "kyc",
  "manual_review",
  "verified",
  "rejected",
]);

export const VERIFICATION_STATUSES = /** @type {const} */ ([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

/**
 * Return the verification record for `walletAddress`, or null.
 *
 * @param {string} walletAddress
 * @returns {object|null}
 */
export function getVerification(walletAddress) {
  return (
    db
      .prepare(
        `SELECT walletAddress, step, status, adminNote, createdAt, updatedAt
         FROM contributor_verification
         WHERE walletAddress = ?`
      )
      .get(walletAddress) ?? null
  );
}

/**
 * Create or update the verification record for `walletAddress`.
 *
 * @param {string} walletAddress
 * @param {string} step     One of VERIFICATION_STEPS
 * @param {string} status   One of VERIFICATION_STATUSES
 * @param {string|null} [adminNote]
 * @returns {object}
 */
export function upsertVerification(walletAddress, step, status, adminNote = null) {
  const now = new Date().toISOString();

  const existing = getVerification(walletAddress);
  const createdAt = existing?.createdAt ?? now;

  db.prepare(`
    INSERT INTO contributor_verification (walletAddress, step, status, adminNote, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(walletAddress)
    DO UPDATE SET step      = excluded.step,
                  status    = excluded.status,
                  adminNote = excluded.adminNote,
                  updatedAt = excluded.updatedAt
  `).run(walletAddress, step, status, adminNote, createdAt, now);

  countWrite();

  return { walletAddress, step, status, adminNote, createdAt, updatedAt: now };
}

/**
 * Return all verification records at a given step (for admin review queues).
 *
 * @param {string} step
 * @param {number} limit
 * @param {number} offset
 * @returns {object[]}
 */
export function getVerificationsByStep(step, limit = 50, offset = 0) {
  return db
    .prepare(
      `SELECT walletAddress, step, status, adminNote, createdAt, updatedAt
       FROM contributor_verification
       WHERE step = ?
       ORDER BY updatedAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(step, limit, offset);
}
