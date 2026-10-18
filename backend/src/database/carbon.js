/**
 * Carbon tracking storage (#1064): per-transaction emissions, offset
 * purchases, and per-wallet auto-offset settings.
 */

import { db, countWrite } from "./core.js";

export function recordEmission({
  walletAddress,
  contractId,
  txHash = null,
  transactionId = null,
  operationCount = 1,
  gramsCo2,
}) {
  // NULL txHash rows never conflict in SQLite (NULLs are distinct in UNIQUE
  // indexes), so they always take the plain-insert path.
  if (txHash === null || txHash === undefined) {
    const result = db
      .prepare(
        `INSERT INTO carbon_emissions
           (walletAddress, contractId, txHash, transactionId, operationCount, gramsCo2)
         VALUES (?, ?, NULL, ?, ?, ?)`
      )
      .run(walletAddress, contractId, transactionId, operationCount, gramsCo2);
    countWrite();
    return result.lastInsertRowid;
  }

  const stmt = db.prepare(`
    INSERT INTO carbon_emissions
      (walletAddress, contractId, txHash, transactionId, operationCount, gramsCo2)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(contractId, txHash, walletAddress)
    DO UPDATE SET operationCount = excluded.operationCount, gramsCo2 = excluded.gramsCo2
  `);
  const result = stmt.run(
    walletAddress,
    contractId,
    txHash,
    transactionId,
    operationCount,
    gramsCo2
  );
  countWrite();
  if (result.lastInsertRowid) return result.lastInsertRowid;
  const existing = db
    .prepare(
      `SELECT id FROM carbon_emissions
        WHERE contractId = ? AND txHash = ? AND walletAddress = ?`
    )
    .get(contractId, txHash, walletAddress);
  return existing?.id ?? null;
}

function dateFilterClause(column, start, end, values) {
  const clauses = [];
  if (start) {
    clauses.push(`${column} >= ?`);
    values.push(start);
  }
  if (end) {
    clauses.push(`${column} <= ?`);
    values.push(end);
  }
  return clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "";
}

export function getUserEmissions(walletAddress, { start = null, end = null } = {}) {
  const values = [walletAddress];
  const dateFilter = dateFilterClause("recordedAt", start, end, values);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS txCount, COALESCE(SUM(gramsCo2), 0) AS totalGrams
         FROM carbon_emissions
        WHERE walletAddress = ? ${dateFilter}`
    )
    .get(...values);
  return { txCount: row?.txCount ?? 0, totalGrams: row?.totalGrams ?? 0 };
}

export function getUserEmissionsByDay(walletAddress, { start = null, end = null, limit = 90 } = {}) {
  const values = [walletAddress];
  const dateFilter = dateFilterClause("recordedAt", start, end, values);
  return db
    .prepare(
      `SELECT date(recordedAt) AS date, COUNT(*) AS txCount, SUM(gramsCo2) AS grams
         FROM carbon_emissions
        WHERE walletAddress = ? ${dateFilter}
        GROUP BY date(recordedAt)
        ORDER BY date ASC
        LIMIT ?`
    )
    .all(...values, limit);
}

export function getProjectEmissions(contractId, { start = null, end = null } = {}) {
  const values = [contractId];
  const dateFilter = dateFilterClause("recordedAt", start, end, values);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS txCount, COALESCE(SUM(gramsCo2), 0) AS totalGrams,
              COUNT(DISTINCT walletAddress) AS contributorCount
         FROM carbon_emissions
        WHERE contractId = ? ${dateFilter}`
    )
    .get(...values);
  return {
    txCount: row?.txCount ?? 0,
    totalGrams: row?.totalGrams ?? 0,
    contributorCount: row?.contributorCount ?? 0,
  };
}

export function getProjectEmissionsByDay(contractId, { start = null, end = null, limit = 90 } = {}) {
  const values = [contractId];
  const dateFilter = dateFilterClause("recordedAt", start, end, values);
  return db
    .prepare(
      `SELECT date(recordedAt) AS date, COUNT(*) AS txCount, SUM(gramsCo2) AS grams
         FROM carbon_emissions
        WHERE contractId = ? ${dateFilter}
        GROUP BY date(recordedAt)
        ORDER BY date ASC
        LIMIT ?`
    )
    .all(...values, limit);
}

export function recordOffset({
  walletAddress,
  contractId = null,
  tonnes,
  amountUsdCents = 0,
  provider = "demo",
  project = "mixed",
  status = "completed",
  autoPurchase = false,
  txHash = null,
}) {
  const stmt = db.prepare(`
    INSERT INTO carbon_offsets
      (walletAddress, contractId, tonnes, amountUsdCents, provider, project, status, autoPurchase, txHash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    walletAddress,
    contractId,
    tonnes,
    amountUsdCents,
    provider,
    project,
    status,
    autoPurchase ? 1 : 0,
    txHash
  );
  countWrite();
  return result.lastInsertRowid;
}

export function getUserOffsets(walletAddress) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS purchaseCount, COALESCE(SUM(tonnes), 0) AS totalTonnes,
              COALESCE(SUM(amountUsdCents), 0) AS totalUsdCents
         FROM carbon_offsets
        WHERE walletAddress = ? AND status = 'completed'`
    )
    .get(walletAddress);
  return {
    purchaseCount: row?.purchaseCount ?? 0,
    totalTonnes: row?.totalTonnes ?? 0,
    totalUsdCents: row?.totalUsdCents ?? 0,
  };
}

export function listUserOffsets(walletAddress, { limit = 50, offset = 0 } = {}) {
  return db
    .prepare(
      `SELECT id, walletAddress, contractId, tonnes, amountUsdCents, provider,
              project, status, autoPurchase, txHash, createdAt
         FROM carbon_offsets
        WHERE walletAddress = ?
        ORDER BY createdAt DESC, id DESC
        LIMIT ? OFFSET ?`
    )
    .all(walletAddress, limit, offset);
}

export function countUserOffsets(walletAddress) {
  return (
    db
      .prepare("SELECT COUNT(*) AS count FROM carbon_offsets WHERE walletAddress = ?")
      .get(walletAddress)?.count ?? 0
  );
}

export function getProjectOffsets(contractId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS purchaseCount, COALESCE(SUM(tonnes), 0) AS totalTonnes,
              COUNT(DISTINCT walletAddress) AS contributorCount
         FROM carbon_offsets
        WHERE contractId = ? AND status = 'completed'`
    )
    .get(contractId);
  return {
    purchaseCount: row?.purchaseCount ?? 0,
    totalTonnes: row?.totalTonnes ?? 0,
    contributorCount: row?.contributorCount ?? 0,
  };
}

export function getCarbonSettings(walletAddress) {
  const row = db
    .prepare(
      "SELECT walletAddress, autoOffsetEnabled, offsetPercentage, updatedAt FROM carbon_settings WHERE walletAddress = ?"
    )
    .get(walletAddress);
  if (!row) return { walletAddress, autoOffsetEnabled: false, offsetPercentage: 1.0 };
  return {
    walletAddress: row.walletAddress,
    autoOffsetEnabled: row.autoOffsetEnabled === 1,
    offsetPercentage: row.offsetPercentage,
  };
}

export function upsertCarbonSettings(walletAddress, { autoOffsetEnabled, offsetPercentage }) {
  const stmt = db.prepare(`
    INSERT INTO carbon_settings (walletAddress, autoOffsetEnabled, offsetPercentage, updatedAt)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(walletAddress)
    DO UPDATE SET autoOffsetEnabled = excluded.autoOffsetEnabled,
                  offsetPercentage = excluded.offsetPercentage,
                  updatedAt = CURRENT_TIMESTAMP
  `);
  stmt.run(walletAddress, autoOffsetEnabled ? 1 : 0, offsetPercentage);
  countWrite();
  return getCarbonSettings(walletAddress);
}

export function listAutoOffsetWallets() {
  return db
    .prepare("SELECT walletAddress, offsetPercentage FROM carbon_settings WHERE autoOffsetEnabled = 1")
    .all()
    .map((row) => ({ walletAddress: row.walletAddress, offsetPercentage: row.offsetPercentage }));
}
