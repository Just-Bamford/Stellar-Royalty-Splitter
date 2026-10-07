/**
 * Reputation and trust score database functions — closes #962.
 *
 * Tracks collaborator reliability metrics:
 * - Payment reliability (on-time payouts received)
 * - Activity consistency (regular distributions)
 * - Trust score calculation based on historical behavior
 */

import db from "../database.js";
import { countWrite } from "../database.js";
import logger from "../logger.js";

/**
 * Initialize reputation tables.
 */
export function initializeReputationTables() {
  db.exec(`
    -- Store reputation metrics per collaborator
    CREATE TABLE IF NOT EXISTS collaborator_reputation (
      walletAddress TEXT PRIMARY KEY,
      totalPayoutsReceived INTEGER DEFAULT 0,
      totalAmountReceived TEXT DEFAULT '0',
      firstPayoutDate DATETIME,
      lastPayoutDate DATETIME,
      consecutiveMonthsActive INTEGER DEFAULT 0,
      missedPayoutOpportunities INTEGER DEFAULT 0,
      averagePayoutAmount TEXT DEFAULT '0',
      trustScore INTEGER DEFAULT 0 CHECK(trustScore >= 0 AND trustScore <= 100),
      reputationTier TEXT DEFAULT 'newcomer' CHECK(reputationTier IN ('newcomer', 'bronze', 'silver', 'gold', 'platinum')),
      lastCalculated DATETIME DEFAULT CURRENT_TIMESTAMP,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Track individual payout events for streak calculations
    CREATE TABLE IF NOT EXISTS reputation_payout_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      walletAddress TEXT NOT NULL,
      contractId TEXT NOT NULL,
      amount TEXT NOT NULL,
      payoutDate DATETIME NOT NULL,
      onTime INTEGER DEFAULT 1,
      FOREIGN KEY(walletAddress) REFERENCES collaborator_reputation(walletAddress) ON DELETE CASCADE
    );

    -- Reputation activity log (disputes, verified projects, endorsements)
    CREATE TABLE IF NOT EXISTS reputation_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      walletAddress TEXT NOT NULL,
      activityType TEXT NOT NULL CHECK(activityType IN ('dispute_opened', 'dispute_resolved', 'project_completed', 'endorsed_by_peer', 'flagged')),
      impactScore INTEGER NOT NULL DEFAULT 0,
      details TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(walletAddress) REFERENCES collaborator_reputation(walletAddress) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_reputation_wallet ON collaborator_reputation(walletAddress);
    CREATE INDEX IF NOT EXISTS idx_reputation_tier ON collaborator_reputation(reputationTier);
    CREATE INDEX IF NOT EXISTS idx_reputation_score ON collaborator_reputation(trustScore);
    CREATE INDEX IF NOT EXISTS idx_payout_events_wallet ON reputation_payout_events(walletAddress);
    CREATE INDEX IF NOT EXISTS idx_payout_events_date ON reputation_payout_events(payoutDate);
    CREATE INDEX IF NOT EXISTS idx_reputation_activities_wallet ON reputation_activities(walletAddress);
    CREATE INDEX IF NOT EXISTS idx_reputation_activities_type ON reputation_activities(activityType);
  `);
}

/**
 * Get or create a reputation record for a wallet address.
 */
export function getOrCreateReputation(walletAddress) {
  let reputation = db
    .prepare("SELECT * FROM collaborator_reputation WHERE walletAddress = ?")
    .get(walletAddress);

  if (!reputation) {
    db.prepare(`
      INSERT INTO collaborator_reputation (walletAddress, trustScore, reputationTier)
      VALUES (?, 50, 'newcomer')
    `).run(walletAddress);
    countWrite();

    reputation = db
      .prepare("SELECT * FROM collaborator_reputation WHERE walletAddress = ?")
      .get(walletAddress);
  }

  return reputation;
}

/**
 * Record a payout event for reputation tracking.
 */
export function recordPayoutEvent(walletAddress, contractId, amount, payoutDate, onTime = true) {
  db.prepare(`
    INSERT INTO reputation_payout_events (walletAddress, contractId, amount, payoutDate, onTime)
    VALUES (?, ?, ?, ?, ?)
  `).run(walletAddress, contractId, amount, payoutDate, onTime ? 1 : 0);
  countWrite();
}

/**
 * Record a reputation activity (dispute, project completion, etc.)
 */
export function recordReputationActivity(walletAddress, activityType, impactScore, details = null) {
  getOrCreateReputation(walletAddress);

  db.prepare(`
    INSERT INTO reputation_activities (walletAddress, activityType, impactScore, details)
    VALUES (?, ?, ?, ?)
  `).run(walletAddress, activityType, impactScore, JSON.stringify(details));
  countWrite();
}

/**
 * Calculate trust score based on various factors.
 * Score ranges from 0-100.
 */
export function calculateTrustScore(walletAddress) {
  const reputation = getOrCreateReputation(walletAddress);

  let score = 50; // Start at neutral

  // Factor 1: Total payouts received (max +25 points)
  const payoutBonus = Math.min(25, Math.floor(reputation.totalPayoutsReceived / 4));
  score += payoutBonus;

  // Factor 2: Activity consistency (max +20 points)
  const consistencyBonus = Math.min(20, reputation.consecutiveMonthsActive * 2);
  score += consistencyBonus;

  // Factor 3: Payment reliability (max +15 points, min -15 points)
  if (reputation.totalPayoutsReceived > 0) {
    const reliabilityRate = 1 - (reputation.missedPayoutOpportunities / (reputation.totalPayoutsReceived + reputation.missedPayoutOpportunities));
    const reliabilityBonus = Math.floor(reliabilityRate * 15) - 7;
    score += reliabilityBonus;
  }

  // Factor 4: Reputation activities (disputes, endorsements)
  const activities = db
    .prepare("SELECT SUM(impactScore) as totalImpact FROM reputation_activities WHERE walletAddress = ?")
    .get(walletAddress);
  const activityImpact = activities?.totalImpact || 0;
  score += Math.max(-20, Math.min(20, activityImpact));

  // Clamp score between 0 and 100
  score = Math.max(0, Math.min(100, score));

  // Determine tier based on score
  let tier = 'newcomer';
  if (score >= 90) tier = 'platinum';
  else if (score >= 75) tier = 'gold';
  else if (score >= 60) tier = 'silver';
  else if (score >= 45) tier = 'bronze';

  // Update the reputation record
  db.prepare(`
    UPDATE collaborator_reputation
    SET trustScore = ?, reputationTier = ?, lastCalculated = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP
    WHERE walletAddress = ?
  `).run(score, tier, walletAddress);
  countWrite();

  return { score, tier };
}

/**
 * Update reputation metrics after a payout.
 */
export function updateReputationAfterPayout(walletAddress, contractId, amount, payoutDate) {
  const reputation = getOrCreateReputation(walletAddress);

  const totalAmount = parseFloat(reputation.totalAmountReceived) + parseFloat(amount);
  const avgAmount = totalAmount / (reputation.totalPayoutsReceived + 1);

  const updates = {
    totalPayoutsReceived: reputation.totalPayoutsReceived + 1,
    totalAmountReceived: totalAmount.toFixed(7),
    averagePayoutAmount: avgAmount.toFixed(7),
    lastPayoutDate: payoutDate,
  };

  if (!reputation.firstPayoutDate) {
    updates.firstPayoutDate = payoutDate;
  }

  // Calculate consecutive months active
  if (reputation.lastPayoutDate) {
    const lastDate = new Date(reputation.lastPayoutDate);
    const currentDate = new Date(payoutDate);
    const monthDiff = (currentDate.getFullYear() - lastDate.getFullYear()) * 12 + 
                     (currentDate.getMonth() - lastDate.getMonth());
    
    if (monthDiff <= 1) {
      updates.consecutiveMonthsActive = reputation.consecutiveMonthsActive + 1;
    } else {
      updates.consecutiveMonthsActive = 1;
    }
  } else {
    updates.consecutiveMonthsActive = 1;
  }

  db.prepare(`
    UPDATE collaborator_reputation
    SET totalPayoutsReceived = ?,
        totalAmountReceived = ?,
        averagePayoutAmount = ?,
        lastPayoutDate = ?,
        firstPayoutDate = COALESCE(firstPayoutDate, ?),
        consecutiveMonthsActive = ?,
        updatedAt = CURRENT_TIMESTAMP
    WHERE walletAddress = ?
  `).run(
    updates.totalPayoutsReceived,
    updates.totalAmountReceived,
    updates.averagePayoutAmount,
    updates.lastPayoutDate,
    updates.firstPayoutDate || null,
    updates.consecutiveMonthsActive,
    walletAddress
  );
  countWrite();

  // Record the payout event
  recordPayoutEvent(walletAddress, contractId, amount, payoutDate, true);

  // Recalculate trust score
  return calculateTrustScore(walletAddress);
}

/**
 * Get reputation details for a wallet address.
 */
export function getReputationDetails(walletAddress) {
  const reputation = getOrCreateReputation(walletAddress);

  const recentPayouts = db
    .prepare(`
      SELECT * FROM reputation_payout_events
      WHERE walletAddress = ?
      ORDER BY payoutDate DESC
      LIMIT 10
    `)
    .all(walletAddress);

  const recentActivities = db
    .prepare(`
      SELECT * FROM reputation_activities
      WHERE walletAddress = ?
      ORDER BY timestamp DESC
      LIMIT 10
    `)
    .all(walletAddress)
    .map(activity => ({
      ...activity,
      details: activity.details ? JSON.parse(activity.details) : null,
    }));

  return {
    ...reputation,
    recentPayouts,
    recentActivities,
  };
}

/**
 * Get top collaborators by trust score.
 */
export function getTopCollaborators(limit = 10) {
  return db
    .prepare(`
      SELECT walletAddress, trustScore, reputationTier, totalPayoutsReceived, totalAmountReceived, consecutiveMonthsActive
      FROM collaborator_reputation
      ORDER BY trustScore DESC, totalPayoutsReceived DESC
      LIMIT ?
    `)
    .all(limit);
}

/**
 * Get collaborators by reputation tier.
 */
export function getCollaboratorsByTier(tier, limit = 50, offset = 0) {
  return db
    .prepare(`
      SELECT * FROM collaborator_reputation
      WHERE reputationTier = ?
      ORDER BY trustScore DESC
      LIMIT ? OFFSET ?
    `)
    .all(tier, limit, offset);
}

/**
 * Count collaborators by tier.
 */
export function countCollaboratorsByTier(tier) {
  return db
    .prepare("SELECT COUNT(*) as total FROM collaborator_reputation WHERE reputationTier = ?")
    .get(tier).total;
}

/**
 * Bulk recalculate all trust scores (maintenance job).
 */
export function recalculateAllTrustScores() {
  const allWallets = db
    .prepare("SELECT walletAddress FROM collaborator_reputation")
    .all();

  let updated = 0;
  for (const { walletAddress } of allWallets) {
    try {
      calculateTrustScore(walletAddress);
      updated++;
    } catch (err) {
      logger.error("Failed to recalculate trust score", { walletAddress, error: err.message });
    }
  }

  logger.info("Bulk trust score recalculation completed", { updated });
  return { updated, total: allWallets.length };
}

/**
 * Get reputation statistics.
 */
export function getReputationStatistics() {
  const tierCounts = db
    .prepare(`
      SELECT reputationTier, COUNT(*) as count
      FROM collaborator_reputation
      GROUP BY reputationTier
    `)
    .all();

  const averageScore = db
    .prepare("SELECT AVG(trustScore) as avg FROM collaborator_reputation")
    .get()?.avg || 0;

  const totalCollaborators = db
    .prepare("SELECT COUNT(*) as total FROM collaborator_reputation")
    .get()?.total || 0;

  return {
    totalCollaborators,
    averageScore: parseFloat(averageScore.toFixed(2)),
    tierDistribution: tierCounts.reduce((acc, { reputationTier, count }) => {
      acc[reputationTier] = count;
      return acc;
    }, {}),
  };
}
