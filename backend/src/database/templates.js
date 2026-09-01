/**
 * Reusable royalty split templates (#652).
 *
 * Application-level presets of collaborator allocations that a wallet can
 * save and re-apply to the initialization form. Templates never touch an
 * on-chain contract — they only pre-fill form inputs.
 */

import { db, countWrite } from "./core.js";

function serializeTemplate(row) {
  return {
    id: row.id,
    walletAddress: row.walletAddress,
    name: row.name,
    allocations: JSON.parse(row.allocations),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Create a new royalty split template for `walletAddress`.
 *
 * @param {string} walletAddress
 * @param {string} name
 * @param {Array<{ address: string, percentage: number }>} allocations
 */
export function createTemplate(walletAddress, name, allocations) {
  const stmt = db.prepare(
    `INSERT INTO royalty_split_templates (walletAddress, name, allocations)
     VALUES (?, ?, ?)`
  );
  const result = stmt.run(walletAddress, name, JSON.stringify(allocations));
  countWrite();
  return getTemplateById(result.lastInsertRowid, walletAddress);
}

/**
 * List all templates owned by `walletAddress`, most recently created first.
 */
export function listTemplates(walletAddress) {
  const rows = db
    .prepare(
      `SELECT id, walletAddress, name, allocations, createdAt, updatedAt
       FROM royalty_split_templates
       WHERE walletAddress = ?
       ORDER BY createdAt DESC`
    )
    .all(walletAddress);

  return rows.map(serializeTemplate);
}

/**
 * Fetch a single template, scoped to its owner.
 */
export function getTemplateById(id, walletAddress) {
  const row = db
    .prepare(
      `SELECT id, walletAddress, name, allocations, createdAt, updatedAt
       FROM royalty_split_templates
       WHERE id = ? AND walletAddress = ?`
    )
    .get(id, walletAddress);

  return row ? serializeTemplate(row) : null;
}

/**
 * Delete a template, scoped to its owner.
 * Returns true if a row was deleted.
 */
export function deleteTemplate(id, walletAddress) {
  const result = db
    .prepare(`DELETE FROM royalty_split_templates WHERE id = ? AND walletAddress = ?`)
    .run(id, walletAddress);
  countWrite();
  return result.changes > 0;
}
