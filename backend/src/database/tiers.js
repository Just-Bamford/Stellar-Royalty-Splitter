/**
 * Contributor Tier System (#589)
 * Stores per-contract tier assignments for collaborator wallet addresses.
 */
import { db, countWrite } from "./core.js";

export const VALID_TIERS = ["vip", "regular", "trial"];

/**
 * Get the tier for a specific contributor in a contract.
 * Returns "regular" when no explicit tier is set.
 */
export function getContributorTier(contractId, walletAddress) {
  const row = db
    .prepare(
      `SELECT tier, notes, updatedAt FROM contributor_tiers
       WHERE contractId = ? AND walletAddress = ?`,
    )
    .get(contractId, walletAddress);
  return row ?? { tier: "regular", notes: null, updatedAt: null };
}

/**
 * Get all tier assignments for a contract.
 * Returns an array of { walletAddress, tier, notes, updatedAt }.
 */
export function getContractTiers(contractId) {
  return db
    .prepare(
      `SELECT walletAddress, tier, notes, updatedAt
       FROM contributor_tiers
       WHERE contractId = ?
       ORDER BY tier, walletAddress`,
    )
    .all(contractId);
}

/**
 * Upsert a tier assignment for a contributor.
 */
export function setContributorTier(contractId, walletAddress, tier, notes = null) {
  if (!VALID_TIERS.includes(tier)) {
    throw new Error(`Invalid tier "${tier}". Must be one of: ${VALID_TIERS.join(", ")}`);
  }
  db.prepare(
    `INSERT INTO contributor_tiers (contractId, walletAddress, tier, notes, updatedAt)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(contractId, walletAddress)
     DO UPDATE SET tier = excluded.tier,
                   notes = excluded.notes,
                   updatedAt = CURRENT_TIMESTAMP`,
  ).run(contractId, walletAddress, tier, notes);
  countWrite();
}

/**
 * Remove a tier assignment (contributor reverts to "regular").
 */
export function removeContributorTier(contractId, walletAddress) {
  db.prepare(
    `DELETE FROM contributor_tiers WHERE contractId = ? AND walletAddress = ?`,
  ).run(contractId, walletAddress);
  countWrite();
}
