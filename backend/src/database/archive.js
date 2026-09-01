/**
 * Contract event archival functions.
 * Moves old transaction-history events into a dedicated archive table.
 */

import { db, countWrite } from "./core.js";

export const DEFAULT_ARCHIVE_RETENTION_DAYS = 90;
export const DEFAULT_ARCHIVE_BATCH_SIZE = 500;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value == null) return fallback;
  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(String(value).toLowerCase())) return false;
  return fallback;
}

export function getArchivePolicy() {
  const row = db
    .prepare(
      `
        SELECT enabled, retentionDays, updatedAt
        FROM event_archive_policy
        WHERE id = 1
      `,
    )
    .get();

  const envEnabled = parseBoolean(process.env.EVENT_ARCHIVE_ENABLED, null);
  const envRetentionDays = process.env.EVENT_ARCHIVE_RETENTION_DAYS
    ? parsePositiveInteger(process.env.EVENT_ARCHIVE_RETENTION_DAYS, DEFAULT_ARCHIVE_RETENTION_DAYS)
    : null;

  return {
    enabled: envEnabled ?? Boolean(row?.enabled ?? 1),
    retentionDays: envRetentionDays ?? row?.retentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS,
    updatedAt: row?.updatedAt ?? null,
  };
}

export function updateArchivePolicy({ enabled, retentionDays }) {
  const current = getArchivePolicy();
  const nextEnabled = enabled == null ? current.enabled : Boolean(enabled);
  const nextRetentionDays =
    retentionDays == null
      ? current.retentionDays
      : parsePositiveInteger(retentionDays, current.retentionDays);

  db.prepare(
    `
      INSERT INTO event_archive_policy (id, enabled, retentionDays, updatedAt)
      VALUES (1, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        retentionDays = excluded.retentionDays,
        updatedAt = CURRENT_TIMESTAMP
    `,
  ).run(nextEnabled ? 1 : 0, nextRetentionDays);
  countWrite();

  return getArchivePolicy();
}

export function getArchiveCutoffDate(retentionDays, now = new Date()) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  return cutoff.toISOString();
}

function mapArchiveRows(rows) {
  return rows.map((row) => {
    let payouts = [];
    try {
      payouts = JSON.parse(row.payoutsJson || "[]");
    } catch (_) {
      payouts = [];
    }
    return {
      ...row,
      payouts,
      payoutsJson: undefined,
    };
  });
}

export function getArchivedEventCount(contractId) {
  const stmt = db.prepare(
    `SELECT COUNT(*) as total FROM contract_event_archive WHERE contractId = ?`,
  );
  return stmt.get(contractId).total;
}

export function getArchivedEvents(contractId, limit = 50, offset = 0) {
  const stmt = db.prepare(
    `
      SELECT
        id,
        originalTransactionId,
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
        payoutCount,
        payoutsJson,
        archivedAt
      FROM contract_event_archive
      WHERE contractId = ?
      ORDER BY COALESCE(blockTime, timestamp) DESC, id DESC
      LIMIT ? OFFSET ?
    `,
  );

  return mapArchiveRows(stmt.all(contractId, limit, offset));
}

export function archiveContractEvents(options = {}) {
  const policy = options.policy ?? getArchivePolicy();
  const batchSize = parsePositiveInteger(options.batchSize, DEFAULT_ARCHIVE_BATCH_SIZE);

  if (!policy.enabled) {
    return {
      archived: 0,
      enabled: false,
      retentionDays: policy.retentionDays,
      cutoff: null,
      durationMs: 0,
    };
  }

  const cutoff = options.cutoff ?? getArchiveCutoffDate(policy.retentionDays, options.now ?? new Date());
  const startedAt = Date.now();

  const archiveBatch = db.transaction(() => {
    const candidates = db
      .prepare(
        `
          SELECT id
          FROM transactions
          WHERE COALESCE(blockTime, timestamp) < ?
          ORDER BY COALESCE(blockTime, timestamp) ASC, id ASC
          LIMIT ?
        `,
      )
      .all(cutoff, batchSize);

    if (candidates.length === 0) {
      return 0;
    }

    const ids = candidates.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");

    db.prepare(
      `
        INSERT OR IGNORE INTO contract_event_archive (
          originalTransactionId,
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
          payoutCount,
          payoutsJson
        )
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
          COUNT(dp.id) as payoutCount,
          COALESCE(
            json_group_array(
              CASE
                WHEN dp.id IS NULL THEN NULL
                ELSE json_object(
                  'collaboratorAddress', dp.collaboratorAddress,
                  'amountReceived', dp.amountReceived
                )
              END
            ) FILTER (WHERE dp.id IS NOT NULL),
            '[]'
          ) as payoutsJson
        FROM transactions t
        LEFT JOIN distribution_payouts dp ON t.id = dp.transactionId
        WHERE t.id IN (${placeholders})
        GROUP BY t.id
      `,
    ).run(...ids);

    db.prepare(`DELETE FROM transactions WHERE id IN (${placeholders})`).run(...ids);
    return ids.length;
  });

  const archived = archiveBatch();
  if (archived > 0) countWrite();

  return {
    archived,
    enabled: true,
    retentionDays: policy.retentionDays,
    cutoff,
    durationMs: Date.now() - startedAt,
  };
}
