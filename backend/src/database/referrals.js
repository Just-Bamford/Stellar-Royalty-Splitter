/**
 * Referral tracking database helpers — closes #603.
 *
 * Provides CRUD operations for the contributor referral system:
 *   - generateReferralLink      — create (or retrieve) a unique referral link for a wallet
 *   - getReferralLinkByWallet   — fetch a wallet's referral link record
 *   - getReferralLinkByCode     — look up a link record by its code
 *   - registerReferral          — record that a new contributor signed up via a referral code
 *   - activateReferral          — mark a referral as active (e.g. after first distribution)
 *   - getReferralByReferred     — get the referral entry for a referred wallet
 *   - getReferralsByReferrer    — list all referrals made by a referrer, with pagination
 *   - countReferralsByReferrer  — count referrals for pagination metadata
 *   - awardReferralBonus        — record a bonus award against a referral
 *   - getBonusesByReferrer      — list all bonus records for a referrer
 *   - getReferralDashboard      — aggregated stats: counts, total bonus, referral list
 *   - getAllReferrals            — admin: paginated list, optional status filter
 *   - countAllReferrals         — admin: count with optional status filter
 */

import { db, countWrite } from "./core.js";
import { randomBytes } from "crypto";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Default referral bonus in stroops (Stellar's smallest unit, 1 XLM = 10,000,000 stroops).
 * 5 XLM per successful referral activation.
 */
export const DEFAULT_REFERRAL_BONUS_STROOPS = 5 * 10_000_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a short, URL-safe referral code (12 uppercase hex characters).
 * e.g. "REF-3A9F21B04C7E"
 * @returns {string}
 */
function generateReferralCode() {
  return "REF-" + randomBytes(6).toString("hex").toUpperCase();
}

// ─── Referral Links ───────────────────────────────────────────────────────────

/**
 * Create a referral link for `walletAddress` if one does not already exist.
 * Idempotent — returns the existing record on subsequent calls.
 *
 * @param {string} walletAddress  Stellar G-address of the referrer
 * @returns {{ id: number, walletAddress: string, referralCode: string, createdAt: string }}
 */
export function generateReferralLink(walletAddress) {
  const existing = getReferralLinkByWallet(walletAddress);
  if (existing) return existing;

  const referralCode = generateReferralCode();
  const now = new Date().toISOString();

  // Retry on the (astronomically unlikely) code collision.
  let result;
  let attempts = 0;
  while (attempts < 5) {
    try {
      result = db
        .prepare(
          `INSERT INTO referral_links (walletAddress, referralCode, createdAt)
           VALUES (?, ?, ?)`
        )
        .run(walletAddress, attempts === 0 ? referralCode : generateReferralCode(), now);
      break;
    } catch (err) {
      if (err.message?.includes("UNIQUE constraint failed") && attempts < 4) {
        attempts++;
        continue;
      }
      throw err;
    }
  }

  countWrite();

  return {
    id: result.lastInsertRowid,
    walletAddress,
    referralCode: db
      .prepare(`SELECT referralCode FROM referral_links WHERE id = ?`)
      .get(result.lastInsertRowid).referralCode,
    createdAt: now,
  };
}

/**
 * Fetch the referral link record for a wallet address.
 *
 * @param {string} walletAddress
 * @returns {{ id: number, walletAddress: string, referralCode: string, createdAt: string } | null}
 */
export function getReferralLinkByWallet(walletAddress) {
  return (
    db
      .prepare(
        `SELECT id, walletAddress, referralCode, createdAt
         FROM referral_links
         WHERE walletAddress = ?`
      )
      .get(walletAddress) ?? null
  );
}

/**
 * Look up a referral link record by its code.
 *
 * @param {string} referralCode
 * @returns {{ id: number, walletAddress: string, referralCode: string, createdAt: string } | null}
 */
export function getReferralLinkByCode(referralCode) {
  return (
    db
      .prepare(
        `SELECT id, walletAddress, referralCode, createdAt
         FROM referral_links
         WHERE referralCode = ?`
      )
      .get(referralCode) ?? null
  );
}

// ─── Referral Registration ────────────────────────────────────────────────────

/**
 * Record that `referredAddress` signed up using `referralCode`.
 * The referral starts in `pending` status; call `activateReferral` once the
 * referred contributor completes their first qualifying action (e.g. receives
 * their first distribution).
 *
 * Throws if:
 *   - The referral code does not correspond to any registered referrer.
 *   - `referredAddress` has already been referred (UNIQUE constraint).
 *   - A contributor tries to refer themselves.
 *
 * @param {object} params
 * @param {string} params.referralCode    Code from the referral link
 * @param {string} params.referredAddress Stellar G-address of the new contributor
 * @returns {{ id: number, referrerAddress: string, referredAddress: string,
 *             referralCode: string, status: string, createdAt: string, activatedAt: null }}
 */
export function registerReferral({ referralCode, referredAddress }) {
  const link = getReferralLinkByCode(referralCode);
  if (!link) {
    const err = new Error("Referral code not found");
    err.status = 404;
    err.code = "referral_code_not_found";
    throw err;
  }

  if (link.walletAddress === referredAddress) {
    const err = new Error("A contributor cannot refer themselves");
    err.status = 400;
    err.code = "self_referral_not_allowed";
    throw err;
  }

  const now = new Date().toISOString();

  let result;
  try {
    result = db
      .prepare(
        `INSERT INTO referrals (referrerAddress, referredAddress, referralCode, status, createdAt)
         VALUES (?, ?, ?, 'pending', ?)`
      )
      .run(link.walletAddress, referredAddress, referralCode, now);
  } catch (err) {
    if (err.message?.includes("UNIQUE constraint failed")) {
      const existing = getReferralByReferred(referredAddress);
      const e = new Error("This contributor has already been referred");
      e.status = 409;
      e.code = "already_referred";
      e.data = existing;
      throw e;
    }
    throw err;
  }

  countWrite();

  return {
    id: result.lastInsertRowid,
    referrerAddress: link.walletAddress,
    referredAddress,
    referralCode,
    status: "pending",
    createdAt: now,
    activatedAt: null,
  };
}

/**
 * Activate a referral and optionally award a bonus to the referrer in a single
 * transaction. Call this once the referred contributor qualifies (e.g. completes
 * their first distribution).
 *
 * @param {object} params
 * @param {string} params.referredAddress       Stellar G-address of the referred contributor
 * @param {number} [params.bonusAmountStroops]  Bonus to award; defaults to DEFAULT_REFERRAL_BONUS_STROOPS
 * @param {string} [params.reason]              Human-readable reason for the bonus record
 * @returns {{ referral: object, bonus: object | null }}
 */
export function activateReferral({
  referredAddress,
  bonusAmountStroops = DEFAULT_REFERRAL_BONUS_STROOPS,
  reason = "First distribution by referred contributor",
}) {
  const referral = getReferralByReferred(referredAddress);
  if (!referral) {
    const err = new Error("No referral record found for this contributor");
    err.status = 404;
    err.code = "referral_not_found";
    throw err;
  }

  if (referral.status !== "pending") {
    // Already activated; return existing record without double-awarding.
    return { referral, bonus: null };
  }

  const now = new Date().toISOString();

  const activate = db.transaction(() => {
    db.prepare(
      `UPDATE referrals
       SET status = 'active', activatedAt = ?
       WHERE id = ?`
    ).run(now, referral.id);

    const bonusResult = db
      .prepare(
        `INSERT INTO referral_bonuses (referralId, referrerAddress, bonusAmountStroops, reason, awardedAt)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(referral.id, referral.referrerAddress, bonusAmountStroops, reason, now);

    countWrite();

    return bonusResult.lastInsertRowid;
  });

  const bonusId = activate();

  const updatedReferral = db
    .prepare(`SELECT * FROM referrals WHERE id = ?`)
    .get(referral.id);

  const bonus = db
    .prepare(`SELECT * FROM referral_bonuses WHERE id = ?`)
    .get(bonusId);

  return { referral: updatedReferral, bonus };
}

// ─── Referral Queries ─────────────────────────────────────────────────────────

/**
 * Get the referral record for a referred wallet address.
 *
 * @param {string} referredAddress
 * @returns {object | null}
 */
export function getReferralByReferred(referredAddress) {
  return (
    db
      .prepare(`SELECT * FROM referrals WHERE referredAddress = ?`)
      .get(referredAddress) ?? null
  );
}

/**
 * List all referrals made by a referrer, newest first.
 *
 * @param {string} referrerAddress
 * @param {{ limit?: number, offset?: number }} [pagination]
 * @returns {object[]}
 */
export function getReferralsByReferrer(referrerAddress, { limit = 50, offset = 0 } = {}) {
  return db
    .prepare(
      `SELECT * FROM referrals
       WHERE referrerAddress = ?
       ORDER BY createdAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(referrerAddress, limit, offset);
}

/**
 * Count referrals for a referrer (for pagination metadata).
 *
 * @param {string} referrerAddress
 * @returns {number}
 */
export function countReferralsByReferrer(referrerAddress) {
  return db
    .prepare(`SELECT COUNT(*) AS total FROM referrals WHERE referrerAddress = ?`)
    .get(referrerAddress).total;
}

// ─── Bonus Queries ────────────────────────────────────────────────────────────

/**
 * Record a bonus award manually (for custom bonus scenarios beyond activation).
 *
 * @param {object} params
 * @param {number} params.referralId          Internal referral row ID
 * @param {string} params.referrerAddress     Stellar G-address of the referrer
 * @param {number} params.bonusAmountStroops  Amount in stroops
 * @param {string} params.reason              Description of why the bonus was awarded
 * @returns {{ id: number, referralId: number, referrerAddress: string,
 *             bonusAmountStroops: number, reason: string, awardedAt: string }}
 */
export function awardReferralBonus({ referralId, referrerAddress, bonusAmountStroops, reason }) {
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO referral_bonuses (referralId, referrerAddress, bonusAmountStroops, reason, awardedAt)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(referralId, referrerAddress, bonusAmountStroops, reason, now);

  countWrite();

  return {
    id: result.lastInsertRowid,
    referralId,
    referrerAddress,
    bonusAmountStroops,
    reason,
    awardedAt: now,
  };
}

/**
 * Fetch all bonus records for a referrer, newest first.
 *
 * @param {string} referrerAddress
 * @returns {object[]}
 */
export function getBonusesByReferrer(referrerAddress) {
  return db
    .prepare(
      `SELECT * FROM referral_bonuses
       WHERE referrerAddress = ?
       ORDER BY awardedAt DESC`
    )
    .all(referrerAddress);
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

/**
 * Return aggregated referral statistics for a contributor's dashboard.
 *
 * @param {string} referrerAddress  Stellar G-address
 * @param {{ limit?: number, offset?: number }} [pagination]
 * @returns {{
 *   referralCode: string | null,
 *   totalReferrals: number,
 *   pendingReferrals: number,
 *   activeReferrals: number,
 *   bonusPaidReferrals: number,
 *   totalBonusStroops: number,
 *   totalBonusXlm: string,
 *   referrals: object[],
 *   pagination: { total: number, limit: number, offset: number }
 * }}
 */
export function getReferralDashboard(referrerAddress, { limit = 50, offset = 0 } = {}) {
  const link = getReferralLinkByWallet(referrerAddress);

  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'bonus_paid' THEN 1 ELSE 0 END) AS bonusPaid
       FROM referrals
       WHERE referrerAddress = ?`
    )
    .get(referrerAddress);

  const bonusRow = db
    .prepare(
      `SELECT COALESCE(SUM(bonusAmountStroops), 0) AS totalStroops
       FROM referral_bonuses
       WHERE referrerAddress = ?`
    )
    .get(referrerAddress);

  const referrals = getReferralsByReferrer(referrerAddress, { limit, offset });
  const totalStroops = bonusRow.totalStroops;

  return {
    referralCode: link?.referralCode ?? null,
    totalReferrals: counts.total,
    pendingReferrals: counts.pending ?? 0,
    activeReferrals: counts.active ?? 0,
    bonusPaidReferrals: counts.bonusPaid ?? 0,
    totalBonusStroops: totalStroops,
    // Human-readable XLM amount (1 XLM = 10,000,000 stroops); formatted to 7 dp.
    totalBonusXlm: (totalStroops / 10_000_000).toFixed(7),
    referrals,
    pagination: { total: counts.total, limit, offset },
  };
}

// ─── Admin ────────────────────────────────────────────────────────────────────

/**
 * Admin: fetch all referrals with optional status filter, newest first.
 *
 * @param {{ status?: string, limit?: number, offset?: number }} [opts]
 * @returns {object[]}
 */
export function getAllReferrals({ status, limit = 50, offset = 0 } = {}) {
  if (status) {
    return db
      .prepare(
        `SELECT * FROM referrals
         WHERE status = ?
         ORDER BY createdAt DESC
         LIMIT ? OFFSET ?`
      )
      .all(status, limit, offset);
  }
  return db
    .prepare(
      `SELECT * FROM referrals
       ORDER BY createdAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

/**
 * Admin: count all referrals with optional status filter.
 *
 * @param {{ status?: string }} [opts]
 * @returns {number}
 */
export function countAllReferrals({ status } = {}) {
  if (status) {
    return db
      .prepare(`SELECT COUNT(*) AS total FROM referrals WHERE status = ?`)
      .get(status).total;
  }
  return db.prepare(`SELECT COUNT(*) AS total FROM referrals`).get().total;
}
