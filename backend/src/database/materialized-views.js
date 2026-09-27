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
    CREATE TABLE IF NOT EXISTS analytics_weekly (
      contractId TEXT NOT NULL, bucket TEXT NOT NULL,
      distributionCount INTEGER NOT NULL, failedCount INTEGER NOT NULL,
      totalAmount TEXT NOT NULL, collaboratorEarnings TEXT NOT NULL,
      activeCollaborators INTEGER NOT NULL DEFAULT 0,
      newCollaborators INTEGER NOT NULL DEFAULT 0,
      returningCollaborators INTEGER NOT NULL DEFAULT 0,
      growthRate REAL NOT NULL DEFAULT 0,
      retentionRate REAL NOT NULL DEFAULT 0,
      avgPayoutPerCollaborator REAL NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (contractId, bucket)
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_hourly_lookup ON analytics_hourly(contractId, bucket DESC);
    CREATE INDEX IF NOT EXISTS idx_analytics_daily_lookup ON analytics_daily(contractId, bucket DESC);
    CREATE INDEX IF NOT EXISTS idx_analytics_weekly_lookup ON analytics_weekly(contractId, bucket DESC);
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
      db.prepare("DELETE FROM analytics_weekly WHERE contractId = ?").run(contractId);
    } else {
      db.exec("DELETE FROM analytics_hourly; DELETE FROM analytics_daily; DELETE FROM analytics_weekly;");
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
    
    // Weekly aggregations with cohort analysis
    db.prepare(`INSERT INTO analytics_weekly
      SELECT 
        t.contractId,
        strftime('%Y-W%W', t.timestamp) as weekBucket,
        SUM(CASE WHEN t.type IN ('distribute','secondary_royalty','secondary_distribute') AND t.status = 'confirmed' THEN 1 ELSE 0 END) as distributionCount,
        SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) as failedCount,
        COALESCE(SUM(CASE WHEN t.status = 'confirmed' THEN CAST(COALESCE(t.requestedAmount, '0') AS REAL) ELSE 0 END), 0) as totalAmount,
        COALESCE((
          SELECT SUM(CAST(dp.amountReceived AS REAL)) 
          FROM distribution_payouts dp 
          JOIN transactions t2 ON t2.id = dp.transactionId 
          WHERE t2.contractId = t.contractId 
            AND strftime('%Y-W%W', t2.timestamp) = strftime('%Y-W%W', t.timestamp)
        ), 0) as collaboratorEarnings,
        (
          SELECT COUNT(DISTINCT dp2.collaboratorAddress) 
          FROM distribution_payouts dp2 
          JOIN transactions t3 ON t3.id = dp2.transactionId 
          WHERE t3.contractId = t.contractId 
            AND strftime('%Y-W%W', t3.timestamp) = strftime('%Y-W%W', t.timestamp)
        ) as activeCollaborators,
        (
          SELECT COUNT(DISTINCT dp_new.collaboratorAddress)
          FROM distribution_payouts dp_new
          JOIN transactions t_new ON t_new.id = dp_new.transactionId
          WHERE t_new.contractId = t.contractId
            AND strftime('%Y-W%W', t_new.timestamp) = strftime('%Y-W%W', t.timestamp)
            AND dp_new.collaboratorAddress NOT IN (
              SELECT DISTINCT dp_old.collaboratorAddress
              FROM distribution_payouts dp_old
              JOIN transactions t_old ON t_old.id = dp_old.transactionId
              WHERE t_old.contractId = t.contractId
                AND t_old.timestamp < t.timestamp
            )
        ) as newCollaborators,
        (
          SELECT COUNT(DISTINCT dp_ret.collaboratorAddress)
          FROM distribution_payouts dp_ret
          JOIN transactions t_ret ON t_ret.id = dp_ret.transactionId
          WHERE t_ret.contractId = t.contractId
            AND strftime('%Y-W%W', t_ret.timestamp) = strftime('%Y-W%W', t.timestamp)
            AND dp_ret.collaboratorAddress IN (
              SELECT DISTINCT dp_prev.collaboratorAddress
              FROM distribution_payouts dp_prev
              JOIN transactions t_prev ON t_prev.id = dp_prev.transactionId
              WHERE t_prev.contractId = t.contractId
                AND t_prev.timestamp < t.timestamp
            )
        ) as returningCollaborators,
        0 as growthRate,
        0 as retentionRate,
        0 as avgPayoutPerCollaborator,
        CURRENT_TIMESTAMP
      FROM transactions t ${where}
      GROUP BY t.contractId, strftime('%Y-W%W', t.timestamp)`).run(...args);
    
    // Calculate growth and retention rates
    if (contractId) {
      calculateWeeklyMetrics(contractId);
    } else {
      const contracts = db.prepare("SELECT DISTINCT contractId FROM analytics_weekly").all();
      contracts.forEach(({ contractId }) => calculateWeeklyMetrics(contractId));
    }
  });
  transaction();
}

function calculateWeeklyMetrics(contractId) {
  const weeks = db.prepare("SELECT bucket, activeCollaborators, newCollaborators, returningCollaborators, collaboratorEarnings FROM analytics_weekly WHERE contractId = ? ORDER BY bucket ASC").all(contractId);
  
  for (let i = 0; i < weeks.length; i++) {
    const current = weeks[i];
    const previous = i > 0 ? weeks[i - 1] : null;
    
    let growthRate = 0;
    let retentionRate = 0;
    let avgPayout = current.activeCollaborators > 0 
      ? parseFloat(current.collaboratorEarnings) / current.activeCollaborators 
      : 0;
    
    if (previous) {
      // Calculate week-over-week growth rate
      if (previous.activeCollaborators > 0) {
        growthRate = ((current.activeCollaborators - previous.activeCollaborators) / previous.activeCollaborators) * 100;
      }
      
      // Calculate retention rate (returning collaborators / previous week's active)
      if (previous.activeCollaborators > 0) {
        retentionRate = (current.returningCollaborators / previous.activeCollaborators) * 100;
      }
    }
    
    db.prepare(`
      UPDATE analytics_weekly 
      SET growthRate = ?, retentionRate = ?, avgPayoutPerCollaborator = ?
      WHERE contractId = ? AND bucket = ?
    `).run(growthRate, retentionRate, avgPayout, contractId, current.bucket);
  }
}

export function getMaterializedSnapshot(contractId, { hours = 24, days = 30, weeks = 12 } = {}) {
  ensureTables();
  return {
    hourly: db.prepare("SELECT * FROM analytics_hourly WHERE contractId = ? ORDER BY bucket DESC LIMIT ?").all(contractId, hours),
    daily: db.prepare("SELECT * FROM analytics_daily WHERE contractId = ? ORDER BY bucket DESC LIMIT ?").all(contractId, days),
    weekly: db.prepare("SELECT * FROM analytics_weekly WHERE contractId = ? ORDER BY bucket DESC LIMIT ?").all(contractId, weeks),
  };
}
