import { db, countWrite } from "./core.js";

/**
 * Get a user's role for a specific contract or global.
 * @param {string|null} contractId 
 * @param {string} walletAddress 
 * @returns {string|null}
 */
export function dbGetUserRole(contractId, walletAddress) {
  // Check contract-specific role first
  if (contractId) {
    const stmt = db.prepare("SELECT role FROM user_roles WHERE contractId = ? AND walletAddress = ?");
    const row = stmt.get(contractId, walletAddress);
    if (row) return row.role;
  }
  // Check global role (contractId IS NULL or empty string)
  const stmtGlobal = db.prepare("SELECT role FROM user_roles WHERE (contractId IS NULL OR contractId = '') AND walletAddress = ?");
  const rowGlobal = stmtGlobal.get(walletAddress);
  return rowGlobal ? rowGlobal.role : null;
}

/**
 * Assign a user role.
 * @param {string|null} contractId 
 * @param {string} walletAddress 
 * @param {string} role 
 * @param {string|null} assignedBy 
 */
export function dbAssignUserRole(contractId, walletAddress, role, assignedBy) {
  const stmt = db.prepare(`
    INSERT INTO user_roles (contractId, walletAddress, role, assignedBy)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(contractId, walletAddress) DO UPDATE SET role = excluded.role, assignedBy = excluded.assignedBy, assignedAt = CURRENT_TIMESTAMP
  `);
  stmt.run(contractId || null, walletAddress, role, assignedBy || null);
  countWrite();
}

/**
 * Check if any roles have been configured.
 * @returns {boolean}
 */
export function dbHasAnyRoles() {
  const stmt = db.prepare("SELECT count(*) as count FROM user_roles");
  const row = stmt.get();
  return row.count > 0;
}
