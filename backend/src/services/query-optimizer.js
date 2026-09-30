/**
 * Database Query Optimizer Service — closes #984.
 *
 * Centralizes query patterns, actively eliminates N+1 query loops across the backend,
 * implements a materialized view equivalent for the earnings dashboard hot path,
 * and provides reusable batched query helpers with full query plan inspection.
 */

import { db, countWrite } from "../database/core.js";
import { cacheGet, cacheSet, cacheKey, TTL } from "../cache.js";
import logger from "../logger.js";

/**
 * Execute EXPLAIN QUERY PLAN on an arbitrary SQL statement to inspect index utilization.
 * SQLite equivalent of EXPLAIN ANALYZE.
 *
 * @param {string} sql - SQL query string
 * @param {Array} [params=[]] - Query parameters
 * @returns {Array<{ id: number, parent: number, notused: number, detail: string }>}
 */
export function explainQueryPlan(sql, params = []) {
  if (!db.open) return [];
  try {
    const stmt = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
    return stmt.all(...params);
  } catch (err) {
    logger.warn("Failed to explain query plan", { sql, error: err.message });
    return [];
  }
}

/**
 * BATCH QUERY: Batch Contributor Status Lookup
 *
 * Problem Solved:
 * Eliminates N+1 query pattern where loops check collaborator status (active/suspended)
 * one-by-one per contributor address. Replaces N individual round trips with a single
 * parameterized query using index idx_contributor_status_contract or idx_contributor_status_active.
 *
 * @param {string} contractId - Stellar contract ID
 * @param {string[]} addresses - Array of collaborator Stellar G-addresses
 * @returns {Map<string, object>} Map of address -> status record
 */
export function batchGetContributorStatus(contractId, addresses) {
  if (!contractId || !Array.isArray(addresses) || addresses.length === 0) {
    return new Map();
  }

  const uniqueAddresses = [...new Set(addresses.filter(Boolean))];
  if (uniqueAddresses.length === 0) return new Map();

  const placeholders = uniqueAddresses.map(() => "?").join(", ");
  const query = `
    SELECT * FROM contributor_status
    WHERE contractId = ? AND address IN (${placeholders})
  `;

  const rows = db.prepare(query).all(contractId, ...uniqueAddresses);
  const statusMap = new Map();

  for (const row of rows) {
    statusMap.set(row.address, row);
  }

  // Populate default active status for collaborators without an explicit record
  for (const addr of uniqueAddresses) {
    if (!statusMap.has(addr)) {
      statusMap.set(addr, {
        contractId,
        address: addr,
        status: "active",
        reason: null,
      });
    }
  }

  return statusMap;
}

/**
 * BATCH QUERY: Batch Transaction Details & Payouts Lookup
 *
 * Problem Solved:
 * Eliminates N+1 queries in services like ai-dispute-analyzer.js where a list of transactions
 * was inspected by calling getTransactionDetails(tx.txHash) in a loop, issuing 100+ separate
 * queries. Replaces this with 2 constant-time indexed queries utilizing idx_transactions_txHash
 * and idx_distribution_payouts_txId.
 *
 * @param {string[]} txHashes - Array of transaction hashes
 * @returns {Map<string, object>} Map of txHash -> { ...transaction, payouts: [] }
 */
export function batchGetTransactionDetails(txHashes) {
  if (!Array.isArray(txHashes) || txHashes.length === 0) {
    return new Map();
  }

  const uniqueHashes = [...new Set(txHashes.filter(Boolean))];
  if (uniqueHashes.length === 0) return new Map();

  const txPlaceholders = uniqueHashes.map(() => "?").join(", ");
  const txRows = db
    .prepare(`SELECT * FROM transactions WHERE txHash IN (${txPlaceholders})`)
    .all(...uniqueHashes);

  const txMap = new Map();
  const txIds = [];

  for (const tx of txRows) {
    txMap.set(tx.txHash, { ...tx, payouts: [] });
    if (tx.id) txIds.push(tx.id);
  }

  if (txIds.length > 0) {
    const payoutPlaceholders = txIds.map(() => "?").join(", ");
    const payoutRows = db
      .prepare(
        `SELECT * FROM distribution_payouts
         WHERE transactionId IN (${payoutPlaceholders})`
      )
      .all(...txIds);

    const payoutsByTxId = new Map();
    for (const payout of payoutRows) {
      if (!payoutsByTxId.has(payout.transactionId)) {
        payoutsByTxId.set(payout.transactionId, []);
      }
      payoutsByTxId.get(payout.transactionId).push(payout);
    }

    for (const tx of txMap.values()) {
      tx.payouts = payoutsByTxId.get(tx.id) || [];
    }
  }

  return txMap;
}

/**
 * BATCH QUERY: Batch Dispute Comments Lookup
 *
 * Problem Solved:
 * Eliminates N+1 query pattern when loading dispute listings and reports with comments.
 * Replaces N individual getDisputeComments queries with a single query using
 * index idx_dispute_comments_dispute_created.
 *
 * @param {number[]} disputeIds - Array of internal dispute row IDs
 * @returns {Map<number, object[]>} Map of disputeId -> array of comment objects
 */
export function batchGetDisputeComments(disputeIds) {
  if (!Array.isArray(disputeIds) || disputeIds.length === 0) {
    return new Map();
  }

  const uniqueIds = [...new Set(disputeIds.filter((id) => Number.isInteger(id)))];
  if (uniqueIds.length === 0) return new Map();

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, disputeId, author, message, createdAt
       FROM dispute_comments
       WHERE disputeId IN (${placeholders})
       ORDER BY disputeId, createdAt ASC`
    )
    .all(...uniqueIds);

  const commentsMap = new Map();
  for (const id of uniqueIds) {
    commentsMap.set(id, []);
  }

  for (const row of rows) {
    commentsMap.get(row.disputeId).push(row);
  }

  return commentsMap;
}

/**
 * BATCH QUERY: Batch Collaborator Reputation Lookup
 *
 * Problem Solved:
 * Eliminates N queries when validating payout eligibility or building contributor leaderboards.
 * Replaces N individual reputation lookups with a single indexed query.
 *
 * @param {string[]} walletAddresses - Array of collaborator Stellar G-addresses
 * @returns {Map<string, object>} Map of walletAddress -> reputation record
 */
export function batchGetCollaboratorReputation(walletAddresses) {
  if (!Array.isArray(walletAddresses) || walletAddresses.length === 0) {
    return new Map();
  }

  const uniqueAddrs = [...new Set(walletAddresses.filter(Boolean))];
  if (uniqueAddrs.length === 0) return new Map();

  const placeholders = uniqueAddrs.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT * FROM collaborator_reputation
       WHERE walletAddress IN (${placeholders})`
    )
    .all(...uniqueAddrs);

  const reputationMap = new Map();
  for (const row of rows) {
    reputationMap.set(row.walletAddress, row);
  }

  return reputationMap;
}

/**
 * MATERIALIZED VIEW HOT PATH: Refresh Precomputed Earnings Summary
 *
 * Refreshes the `earnings_summary_mv` table for a given contract.
 * Aggregates confirmed distributions, total payout volume, average payout,
 * and unique collaborator count, persisting the result to avoid real-time
 * multi-table JOINs on subsequent dashboard queries.
 *
 * @param {string} contractId - Stellar contract ID
 * @returns {object} Freshly computed summary record
 */
export function refreshEarningsSummaryMV(contractId) {
  if (!contractId || !db.open) return null;

  try {
    const raw = db
      .prepare(
        `SELECT
          COUNT(DISTINCT t.id) as totalTransactions,
          COALESCE(SUM(CAST(dp.amountReceived as REAL)), 0) as totalDistributed,
          COALESCE(AVG(CAST(dp.amountReceived as REAL)), 0) as averagePayout,
          COUNT(DISTINCT dp.collaboratorAddress) as uniqueCollaborators,
          MAX(COALESCE(t.blockTime, t.timestamp)) as lastPayoutAt
        FROM transactions t
        LEFT JOIN distribution_payouts dp ON dp.transactionId = t.id
        WHERE t.contractId = ?
          AND t.status = 'confirmed'
          AND t.type != 'initialize'`
      )
      .get(contractId);

    const totalDistributed = (raw?.totalDistributed ?? 0).toFixed(2);
    const averagePayout = (raw?.averagePayout ?? 0).toFixed(2);
    const totalTransactions = raw?.totalTransactions ?? 0;
    const uniqueCollaborators = raw?.uniqueCollaborators ?? 0;
    const lastPayoutAt = raw?.lastPayoutAt ?? null;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO earnings_summary_mv
        (contractId, totalTransactions, totalDistributed, averagePayout, uniqueCollaborators, lastPayoutAt, lastRefreshedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(contractId) DO UPDATE SET
        totalTransactions = excluded.totalTransactions,
        totalDistributed = excluded.totalDistributed,
        averagePayout = excluded.averagePayout,
        uniqueCollaborators = excluded.uniqueCollaborators,
        lastPayoutAt = excluded.lastPayoutAt,
        lastRefreshedAt = excluded.lastRefreshedAt`
    ).run(
      contractId,
      totalTransactions,
      totalDistributed,
      averagePayout,
      uniqueCollaborators,
      lastPayoutAt,
      now
    );

    countWrite();

    const summary = {
      contractId,
      totalTransactions,
      totalDistributed,
      averagePayout,
      uniqueCollaborators,
      lastPayoutAt,
      lastRefreshedAt: now,
    };

    // Update in-memory cache
    const key = cacheKey("earnings-mv", contractId);
    cacheSet(key, summary, TTL.dashboard ?? 60_000);

    return summary;
  } catch (err) {
    logger.error("Failed to refresh earnings summary materialized view", {
      contractId,
      error: err.message,
    });
    return null;
  }
}

/**
 * HOT PATH: Optimized Earnings Dashboard Summary
 *
 * Problem Solved:
 * The earnings dashboard is the highest-volume read endpoint. Calculating totals via
 * runtime aggregation across transactions and distribution_payouts requires heavy table
 * scans and B-tree sorting.
 *
 * Solution Architecture:
 * 1. Fast path: In-memory multi-tier cache (`cacheGet`).
 * 2. Secondary path: Fast single-row indexed read from `earnings_summary_mv`.
 * 3. Background refresh: If MV record is older than 5 minutes or missing, recomputes
 *    asynchronously or synchronously on demand.
 *
 * @param {string} contractId - Stellar contract ID
 * @param {object} [options]
 * @param {boolean} [options.forceRefresh=false]
 * @returns {object} Dashboard summary stats
 */
export function getOptimizedEarningsSummary(contractId, { forceRefresh = false } = {}) {
  if (!contractId) return null;

  const key = cacheKey("earnings-mv", contractId);
  if (!forceRefresh) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }

  // Query precomputed summary table
  const row = db
    .prepare(`SELECT * FROM earnings_summary_mv WHERE contractId = ?`)
    .get(contractId);

  const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
  const isStale =
    !row ||
    !row.lastRefreshedAt ||
    Date.now() - new Date(row.lastRefreshedAt).getTime() > STALE_THRESHOLD_MS;

  if (row && !isStale && !forceRefresh) {
    const summary = {
      contractId: row.contractId,
      totalTransactions: row.totalTransactions,
      totalDistributed: row.totalDistributed,
      averagePayout: row.averagePayout,
      uniqueCollaborators: row.uniqueCollaborators,
      lastPayoutAt: row.lastPayoutAt,
      lastRefreshedAt: row.lastRefreshedAt,
    };
    cacheSet(key, summary, TTL.dashboard ?? 60_000);
    return summary;
  }

  // Recompute and persist
  return refreshEarningsSummaryMV(contractId);
}

export default {
  explainQueryPlan,
  batchGetContributorStatus,
  batchGetTransactionDetails,
  batchGetDisputeComments,
  batchGetCollaboratorReputation,
  refreshEarningsSummaryMV,
  getOptimizedEarningsSummary,
};
