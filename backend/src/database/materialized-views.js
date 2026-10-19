import db from "../database.js";

let initialized = false;

function ensureTables() {
  if (initialized) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS analytics_hourly (
      contractId TEXT NOT NULL, bucket TEXT NOT NULL,
      distributionCount INTEGER NOT NULL, failedCount INTEGER NOT NULL,
      totalAmount TEXT NOT NULL, collaboratorEarnings TEXT NOT NULL,
      gasUsage INTEGER NOT NULL DEFAULT 0, updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (contractId, bucket)
    );
    CREATE TABLE IF NOT EXISTS analytics_daily (
      contractId TEXT NOT NULL, bucket TEXT NOT NULL,
      distributionCount INTEGER NOT NULL, failedCount INTEGER NOT NULL,
      totalAmount TEXT NOT NULL, collaboratorEarnings TEXT NOT NULL,
      activeCollaborators INTEGER NOT NULL DEFAULT 0, updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (contractId, bucket)
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_hourly_lookup ON analytics_hourly(contractId, bucket DESC);
    CREATE INDEX IF NOT EXISTS idx_analytics_daily_lookup ON analytics_daily(contractId, bucket DESC);
  `);
  initialized = true;
}

export function refreshMaterializedViews(contractId = null) {
  ensureTables();
  const args = contractId ? [contractId] : [];
  const where = contractId ? "WHERE t.contractId = ?" : "";
  const transaction = db.transaction(() => {
    if (contractId) {
      db.prepare("DELETE FROM analytics_hourly WHERE contractId = ?").run(contractId);
      db.prepare("DELETE FROM analytics_daily WHERE contractId = ?").run(contractId);
    } else {
      db.exec("DELETE FROM analytics_hourly; DELETE FROM analytics_daily;");
    }
    db.prepare(`INSERT INTO analytics_hourly
      SELECT t.contractId, strftime('%Y-%m-%dT%H:00:00Z', t.timestamp),
        SUM(CASE WHEN t.type IN ('distribute','secondary_royalty','secondary_distribute') AND t.status = 'confirmed' THEN 1 ELSE 0 END),
        SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END),
        COALESCE(SUM(CASE WHEN t.status = 'confirmed' THEN CAST(COALESCE(t.requestedAmount, '0') AS REAL) ELSE 0 END), 0),
        COALESCE((SELECT SUM(CAST(dp.amountReceived AS REAL)) FROM distribution_payouts dp WHERE dp.transactionId IN (SELECT t2.id FROM transactions t2 WHERE t2.contractId = t.contractId AND strftime('%Y-%m-%dT%H:00:00Z', t2.timestamp) = strftime('%Y-%m-%dT%H:00:00Z', t.timestamp))), 0),
        0, CURRENT_TIMESTAMP
      FROM transactions t ${where} GROUP BY t.contractId, strftime('%Y-%m-%dT%H:00:00Z', t.timestamp)`).run(...args);
    db.prepare(`INSERT INTO analytics_daily
      SELECT t.contractId, date(t.timestamp),
        SUM(CASE WHEN t.type IN ('distribute','secondary_royalty','secondary_distribute') AND t.status = 'confirmed' THEN 1 ELSE 0 END),
        SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END),
        COALESCE(SUM(CASE WHEN t.status = 'confirmed' THEN CAST(COALESCE(t.requestedAmount, '0') AS REAL) ELSE 0 END), 0),
        COALESCE((SELECT SUM(CAST(dp.amountReceived AS REAL)) FROM distribution_payouts dp WHERE dp.transactionId IN (SELECT t2.id FROM transactions t2 WHERE t2.contractId = t.contractId AND date(t2.timestamp) = date(t.timestamp))), 0),
        (SELECT COUNT(DISTINCT dp2.collaboratorAddress) FROM distribution_payouts dp2 JOIN transactions t3 ON t3.id = dp2.transactionId WHERE t3.contractId = t.contractId AND date(t3.timestamp) = date(t.timestamp)), CURRENT_TIMESTAMP
      FROM transactions t ${where} GROUP BY t.contractId, date(t.timestamp)`).run(...args);
  });
  transaction();
}

export function getMaterializedSnapshot(contractId, { hours = 24, days = 30 } = {}) {
  ensureTables();
  return {
    hourly: db.prepare("SELECT * FROM analytics_hourly WHERE contractId = ? ORDER BY bucket DESC LIMIT ?").all(contractId, hours),
    daily: db.prepare("SELECT * FROM analytics_daily WHERE contractId = ? ORDER BY bucket DESC LIMIT ?").all(contractId, days),
  };
}
