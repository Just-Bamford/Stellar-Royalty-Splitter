/**
 * Transaction tracking and distribution payout functions.
 * Handles recording, updating, and querying transactions and their related payouts.
 */

import { db, countWrite } from "./core.js";

/**
 * Exponential backoff delays in milliseconds for each retry attempt.
 * retry_count 0 -> wait 1m, retry_count 1 -> wait 5m, retry_count 2 -> wait 15m
 */
export const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000];
export const MAX_RETRY_COUNT = 3;

export function recordTransaction(contractId, type, initiatorAddress, data) {
  const { requestedAmount, tokenId } = data;

  const stmt = db.prepare(`
    INSERT INTO transactions 
    (contractId, type, initiatorAddress, requestedAmount, tokenId, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);

  const result = stmt.run(contractId, type, initiatorAddress, requestedAmount, tokenId);
  countWrite();
  return result.lastInsertRowid;
}

export function updateTransactionHash(transactionId, txHash) {
  const stmt = db.prepare(`
    UPDATE transactions 
    SET txHash = ? 
    WHERE id = ?
  `);

  stmt.run(txHash, transactionId);
  countWrite();
}

export function updateTransactionStatus(txHash, status, blockTime = null, errorMessage = null) {
  const stmt = db.prepare(`
    UPDATE transactions 
    SET status = ?, blockTime = ?, errorMessage = ? 
    WHERE txHash = ?
  `);

  stmt.run(status, blockTime, errorMessage, txHash);
  countWrite();
}

export function addDistributionPayout(
  transactionId,
  contractId,
  collaboratorAddress,
  amountReceived
) {
  const stmt = db.prepare(`
    INSERT INTO distribution_payouts 
    (transactionId, contractId, collaboratorAddress, amountReceived)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(transactionId, contractId, collaboratorAddress, amountReceived);
  countWrite();
}

export function getTransactionCount(contractId, filters = {}) {
  const conditions = ["t.contractId = ?"];
  const params = [contractId];

  if (filters.type) {
    conditions.push("t.type = ?");
    params.push(filters.type);
  }

  if (filters.recipient) {
    conditions.push(
      "EXISTS (SELECT 1 FROM distribution_payouts dp2 WHERE dp2.transactionId = t.id AND dp2.collaboratorAddress LIKE ?)"
    );
    params.push(`%${filters.recipient}%`);
  }

  if (filters.startDate) {
    conditions.push("t.timestamp >= ?");
    params.push(filters.startDate);
  }

  if (filters.endDate) {
    conditions.push("t.timestamp <= ?");
    params.push(filters.endDate);
  }

  const stmt = db.prepare(
    `SELECT COUNT(*) as total FROM transactions t WHERE ${conditions.join(" AND ")}`
  );
  return stmt.get(...params).total;
}

export function getTransactionHistory(contractId, limit = 50, offset = 0, filters = {}) {
  const conditions = ["t.contractId = ?"];
  const params = [contractId];

  if (filters.type) {
    conditions.push("t.type = ?");
    params.push(filters.type);
  }

  if (filters.recipient) {
    conditions.push(
      "EXISTS (SELECT 1 FROM distribution_payouts dp2 WHERE dp2.transactionId = t.id AND dp2.collaboratorAddress LIKE ?)"
    );
    params.push(`%${filters.recipient}%`);
  }

  if (filters.startDate) {
    conditions.push("t.timestamp >= ?");
    params.push(filters.startDate);
  }

  if (filters.endDate) {
    conditions.push("t.timestamp <= ?");
    params.push(filters.endDate);
  }

  const stmt = db.prepare(`
    SELECT
      t.id,
      t.txHash,
      t.contractId,
      t.type,
      t.initiatorAddress,
      t.requestedAmount,
      t.tokenId,
      t.timestamp,
      t.blockTime,
      t.status,
      t.errorMessage,
      t.retry_count,
      t.last_retry_time,
      COUNT(dp.id) as payoutCount
    FROM transactions t
    LEFT JOIN distribution_payouts dp ON t.id = dp.transactionId
    WHERE ${conditions.join(" AND ")}
    GROUP BY t.id
    ORDER BY t.timestamp DESC, t.id DESC
    LIMIT ? OFFSET ?
  `);

  return stmt.all(...params, limit, offset);
}

/**
 * Cursor-based pagination for transaction history.
 * Uses keyset pagination on (timestamp DESC, id DESC) for efficient deep paging.
 * @param {string} contractId
 * @param {number} limit
 * @param {{ timestamp: string, id: number } | null} cursor
 * @param {object} filters
 * @returns {{ data: Array, nextCursor: string | null }}
 */
export function getTransactionHistoryCursor(contractId, limit, cursor, filters = {}) {
  const conditions = ["t.contractId = ?"];
  const params = [contractId];

  if (filters.type) {
    conditions.push("t.type = ?");
    params.push(filters.type);
  }

  if (filters.recipient) {
    conditions.push(
      "EXISTS (SELECT 1 FROM distribution_payouts dp2 WHERE dp2.transactionId = t.id AND dp2.collaboratorAddress LIKE ?)"
    );
    params.push(`%${filters.recipient}%`);
  }

  if (filters.startDate) {
    conditions.push("t.timestamp >= ?");
    params.push(filters.startDate);
  }

  if (filters.endDate) {
    conditions.push("t.timestamp <= ?");
    params.push(filters.endDate);
  }

  if (cursor) {
    conditions.push("(t.timestamp < ? OR (t.timestamp = ? AND t.id < ?))");
    params.push(cursor.timestamp, cursor.timestamp, cursor.id);
  }

  const stmt = db.prepare(`
    SELECT
      t.id,
      t.txHash,
      t.contractId,
      t.type,
      t.initiatorAddress,
      t.requestedAmount,
      t.tokenId,
      t.timestamp,
      t.blockTime,
      t.status,
      t.errorMessage,
      t.retry_count,
      t.last_retry_time,
      COUNT(dp.id) as payoutCount
    FROM transactions t
    LEFT JOIN distribution_payouts dp ON t.id = dp.transactionId
    WHERE ${conditions.join(" AND ")}
    GROUP BY t.id
    ORDER BY t.timestamp DESC, t.id DESC
    LIMIT ?
  `);

  const data = stmt.all(...params, limit + 1);
  const hasMore = data.length > limit;
  const rows = hasMore ? data.slice(0, limit) : data;
  const nextCursor = hasMore && rows.length > 0
    ? { timestamp: rows[rows.length - 1].timestamp, id: rows[rows.length - 1].id }
    : null;

  return { data: rows, nextCursor };
}

export function getTransactionById(transactionId) {
  const stmt = db.prepare(`
    SELECT
      t.id,
      t.txHash,
      t.contractId,
      t.type,
      t.initiatorAddress,
      t.requestedAmount,
      t.tokenId,
      t.timestamp,
      t.blockTime,
      t.status,
      t.errorMessage,
      t.retry_count,
      t.last_retry_time
    FROM transactions t
    WHERE t.id = ?
  `);

  return stmt.get(transactionId) ?? null;
}

export function getTransactionDetails(txHash) {
  if (!txHash) return null;

  const stmt = db.prepare(`
    SELECT 
      t.id,
      t.txHash,
      t.contractId,
      t.type,
      t.initiatorAddress,
      t.requestedAmount,
      t.tokenId,
      t.timestamp,
      t.blockTime,
      t.status,
      t.errorMessage,
      t.retry_count,
      t.last_retry_time
    FROM transactions t
    WHERE t.txHash = ?
  `);

  let transaction = stmt.get(txHash);

  if (!transaction) {
    // Check contract_event_archive if transaction was archived
    const archiveStmt = db.prepare(`
      SELECT
        originalTransactionId as id,
        txHash,
        contractId,
        type,
        initiatorAddress,
        requestedAmount,
        tokenId,
        timestamp,
        blockTime,
        status,
        errorMessage,
        payoutsJson
      FROM contract_event_archive
      WHERE txHash = ?
    `);

    const archived = archiveStmt.get(txHash);
    if (!archived) {
      return null;
    }

    let rawPayouts = [];
    try {
      rawPayouts = JSON.parse(archived.payoutsJson || "[]");
    } catch (_) {
      rawPayouts = [];
    }

    transaction = {
      ...archived,
      payouts: rawPayouts,
      payoutsJson: undefined,
    };
  } else {
    const payoutsStmt = db.prepare(`
      SELECT collaboratorAddress, amountReceived
      FROM distribution_payouts
      WHERE transactionId = ?
    `);
    transaction.payouts = payoutsStmt.all(transaction.id);
  }

  // Calculate total payouts and share percentages per recipient
  const totalPayoutNum = (transaction.payouts || []).reduce(
    (acc, p) => acc + (parseFloat(p.amountReceived) || 0),
    0
  );

  const payoutsWithShares = (transaction.payouts || []).map((p) => {
    const amt = parseFloat(p.amountReceived) || 0;
    const sharePercentage =
      totalPayoutNum > 0 ? parseFloat(((amt / totalPayoutNum) * 100).toFixed(2)) : 0;
    return {
      ...p,
      sharePercentage,
    };
  });

  // Query edit history / audit log for this contract
  let auditHistory = [];
  try {
    const auditStmt = db.prepare(`
      SELECT id, contractId, action, user, details, timestamp
      FROM audit_log
      WHERE contractId = ?
      ORDER BY timestamp DESC
      LIMIT 20
    `);
    auditHistory = auditStmt.all(transaction.contractId).map((row) => {
      let details = null;
      try {
        details = JSON.parse(row.details || "{}");
      } catch (_) {
        details = row.details;
      }
      return { ...row, details };
    });
  } catch (_) {
    auditHistory = [];
  }

  // Construct structured Soroban contract events data
  const contractEvents = [
    {
      id: `evt-${transaction.id}-invoked`,
      type: "contract_invocation",
      contractId: transaction.contractId,
      topics: ["contract_call", transaction.type, transaction.contractId],
      data: {
        function: transaction.type,
        initiator: transaction.initiatorAddress,
        tokenId: transaction.tokenId || "XLM",
        requestedAmount: transaction.requestedAmount || "0",
        status: transaction.status,
      },
      timestamp: transaction.blockTime || transaction.timestamp,
    },
    {
      id: `evt-${transaction.id}-payouts`,
      type: "distribution_event",
      contractId: transaction.contractId,
      topics: ["royalty_split", "distribution_completed"],
      data: {
        totalDistributed: totalPayoutNum.toString(),
        recipientCount: payoutsWithShares.length,
        payoutsSummary: payoutsWithShares.map((p) => ({
          address: p.collaboratorAddress,
          amount: p.amountReceived,
          share: `${p.sharePercentage}%`,
        })),
      },
      timestamp: transaction.blockTime || transaction.timestamp,
    },
  ];

  return {
    ...transaction,
    payouts: payoutsWithShares,
    totalPayout: totalPayoutNum.toString(),
    auditHistory,
    contractEvents,
  };
}


export function getRetryEligibleTransactions(limit = 10) {
  const stmt = db.prepare(`
    SELECT *
    FROM transactions
    WHERE status = 'failed' AND retry_count < ?
    ORDER BY CASE WHEN last_retry_time IS NULL THEN 0 ELSE 1 END, last_retry_time ASC, id ASC
    LIMIT ?
  `);
  return stmt.all(MAX_RETRY_COUNT, limit);
}
