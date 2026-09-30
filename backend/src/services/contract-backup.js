/**
 * Contract backup service — snapshots contract state to IPFS weekly.
 *
 * Architecture:
 *  - takeSnapshot(contractId)  builds a full JSON snapshot of all DB state
 *    for a contract and uploads it to IPFS via the Pinata pinning API.
 *  - runBackupJob(now)          polls all active contracts and creates a
 *    snapshot for any that are missing a backup in the current ISO week.
 *  - startBackupScheduler()    wires runBackupJob into a setInterval that
 *    fires every BACKUP_CHECK_INTERVAL_MS (default 1 h), following the same
 *    pattern as the existing retry and distribution schedulers.
 *  - pruneHistory(contractId)  trims to 52 weeks after each successful snap.
 *
 * IPFS upload:
 *  Uses the Pinata REST API (https://api.pinata.cloud/pinning/pinJSONToIPFS).
 *  Set PINATA_JWT in the environment to enable real uploads.  When the env
 *  var is absent the service runs in DRY_RUN mode — the snapshot JSON is
 *  built and validated but not uploaded; a deterministic stub CID is stored
 *  so all downstream logic (history, recovery drills) still exercises the
 *  full code path.
 *
 * Acceptance criteria addressed:
 *  ✅ Weekly backups automated (setInterval scheduler)
 *  ✅ Backups stored in IPFS (Pinata pinning)
 *  ✅ 52-week history maintained (pruneHistory)
 */

import {
  createBackupRecord,
  markBackupUploading,
  markBackupCompleted,
  markBackupFailed,
  backupExistsForWeek,
  pruneOldBackups,
  getIsoWeek,
  getContractsWithBackups,
} from "../database/backups.js";
import { db } from "../database/core.js";
import { addAuditLog } from "../database/index.js";
import logger from "../logger.js";
import { parsePositiveInt } from "../utils.js";

// ── Configuration ─────────────────────────────────────────────────────────────

const PINATA_JWT         = process.env.PINATA_JWT ?? null;
const PINATA_API_URL     = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
const IPFS_GATEWAY_BASE  = process.env.IPFS_GATEWAY_BASE ?? "https://gateway.pinata.cloud/ipfs";
const UPLOAD_TIMEOUT_MS  = parsePositiveInt(process.env.BACKUP_UPLOAD_TIMEOUT_MS, 30_000);
const BACKUP_CHECK_INTERVAL_MS = parsePositiveInt(
  process.env.BACKUP_CHECK_INTERVAL_MS,
  60 * 60 * 1000, // 1 hour
);

export const SNAPSHOT_VERSION = 1;

// ── Snapshot builder ──────────────────────────────────────────────────────────

/**
 * Build a complete JSON snapshot of all contract state from the local DB.
 *
 * @param {string} contractId
 * @returns {{
 *   version: number,
 *   contractId: string,
 *   snapshotAt: string,
 *   transactions: object[],
 *   distributionPayouts: object[],
 *   secondarySales: object[],
 *   secondaryRoyaltyDistributions: object[],
 *   auditLog: object[],
 *   metrics: {
 *     transactionCount: number,
 *     collaboratorCount: number,
 *     secondarySaleCount: number,
 *     auditLogCount: number,
 *   }
 * }}
 */
export function buildSnapshot(contractId) {
  const transactions = db
    .prepare(`SELECT * FROM transactions WHERE contractId = ? ORDER BY id ASC`)
    .all(contractId);

  const txIds = transactions.map((t) => t.id);
  let distributionPayouts = [];
  if (txIds.length > 0) {
    const placeholders = txIds.map(() => "?").join(",");
    distributionPayouts = db
      .prepare(
        `SELECT * FROM distribution_payouts WHERE transactionId IN (${placeholders}) ORDER BY id ASC`,
      )
      .all(...txIds);
  }

  const secondarySales = db
    .prepare(`SELECT * FROM secondary_sales WHERE contractId = ? ORDER BY id ASC`)
    .all(contractId);

  const secondaryRoyaltyDistributions = db
    .prepare(
      `SELECT * FROM secondary_royalty_distributions WHERE contractId = ? ORDER BY id ASC`,
    )
    .all(contractId);

  const auditLog = db
    .prepare(`SELECT * FROM audit_log WHERE contractId = ? ORDER BY id ASC`)
    .all(contractId);

  // Unique collaborator addresses derived from distribution_payouts
  const collaboratorAddresses = [
    ...new Set(distributionPayouts.map((p) => p.collaboratorAddress)),
  ];

  return {
    version: SNAPSHOT_VERSION,
    contractId,
    snapshotAt: new Date().toISOString(),
    transactions,
    distributionPayouts,
    secondarySales,
    secondaryRoyaltyDistributions,
    auditLog,
    metrics: {
      transactionCount: transactions.length,
      collaboratorCount: collaboratorAddresses.length,
      secondarySaleCount: secondarySales.length,
      auditLogCount: auditLog.length,
    },
  };
}

// ── IPFS upload ───────────────────────────────────────────────────────────────

/**
 * Upload a snapshot payload to IPFS via Pinata.
 *
 * Returns { cid, gatewayUrl, sizeBytes } on success.
 * In DRY_RUN mode (no PINATA_JWT) returns a stub CID without uploading.
 *
 * @param {object} snapshot
 * @param {string} contractId
 * @returns {Promise<{ cid: string, gatewayUrl: string, sizeBytes: number }>}
 */
export async function uploadToIpfs(snapshot, contractId) {
  const json = JSON.stringify(snapshot);
  const sizeBytes = Buffer.byteLength(json, "utf8");

  // Dry-run mode: no Pinata JWT configured
  if (!PINATA_JWT) {
    logger.info("IPFS upload dry-run (PINATA_JWT not set)", {
      contractId,
      sizeBytes,
    });
    // Deterministic stub CID based on contract + week so tests are stable
    const { weekNumber, yearNumber } = getIsoWeek();
    const cid = `bafyDRYRUN${contractId.slice(0, 8)}W${yearNumber}W${weekNumber}`;
    return {
      cid,
      gatewayUrl: `${IPFS_GATEWAY_BASE}/${cid}`,
      sizeBytes,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    const body = JSON.stringify({
      pinataContent: snapshot,
      pinataMetadata: {
        name: `srs-backup-${contractId.slice(0, 12)}-${snapshot.snapshotAt}`,
        keyvalues: {
          contractId,
          snapshotVersion: String(SNAPSHOT_VERSION),
          snapshotAt: snapshot.snapshotAt,
        },
      },
      pinataOptions: { cidVersion: 1 },
    });

    const res = await fetch(PINATA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PINATA_JWT}`,
      },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Pinata API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    const cid = data.IpfsHash;
    return {
      cid,
      gatewayUrl: `${IPFS_GATEWAY_BASE}/${cid}`,
      sizeBytes,
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`IPFS upload timed out after ${UPLOAD_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Main backup function ──────────────────────────────────────────────────────

/**
 * Take a full snapshot of a contract and store it in IPFS.
 *
 * @param {string} contractId
 * @param {Date}   [now]       Injectable for testing
 * @param {object} [opts]
 * @param {boolean} [opts.force]  Skip the duplicate-week guard
 * @returns {Promise<{
 *   backupId: number,
 *   cid: string,
 *   gatewayUrl: string,
 *   sizeBytes: number,
 *   metrics: object,
 *   dryRun: boolean,
 * }>}
 */
export async function takeSnapshot(contractId, now = new Date(), opts = {}) {
  const { weekNumber, yearNumber } = getIsoWeek(now);

  if (!opts.force && backupExistsForWeek(contractId, weekNumber, yearNumber)) {
    logger.info("Backup already exists for this week — skipping", {
      contractId, weekNumber, yearNumber,
    });
    return null;
  }

  const backupId = createBackupRecord({ contractId, weekNumber, yearNumber });

  logger.info("Starting contract snapshot", {
    event: "backup_start",
    contractId,
    backupId,
    weekNumber,
    yearNumber,
  });

  try {
    markBackupUploading(backupId);

    const snapshot = buildSnapshot(contractId);
    const { cid, gatewayUrl, sizeBytes } = await uploadToIpfs(snapshot, contractId);

    markBackupCompleted(backupId, {
      ipfsCid: cid,
      ipfsGatewayUrl: gatewayUrl,
      sizeBytes,
      transactionCount:    snapshot.metrics.transactionCount,
      collaboratorCount:   snapshot.metrics.collaboratorCount,
      secondarySaleCount:  snapshot.metrics.secondarySaleCount,
      auditLogCount:       snapshot.metrics.auditLogCount,
    });

    // Keep only 52 weeks
    const pruned = pruneOldBackups(contractId);
    if (pruned > 0) {
      logger.info("Pruned old backups beyond 52-week retention", {
        contractId, pruned,
      });
    }

    addAuditLog(contractId, "contract_backup_completed", "system", {
      backupId,
      cid,
      sizeBytes,
      weekNumber,
      yearNumber,
      dryRun: !PINATA_JWT,
    });

    logger.info("Contract snapshot completed", {
      event: "backup_complete",
      contractId,
      backupId,
      cid,
      sizeBytes,
    });

    return {
      backupId,
      cid,
      gatewayUrl,
      sizeBytes,
      metrics: snapshot.metrics,
      dryRun: !PINATA_JWT,
    };
  } catch (err) {
    const msg = err?.message ?? String(err);
    markBackupFailed(backupId, msg);

    addAuditLog(contractId, "contract_backup_failed", "system", {
      backupId, error: msg, weekNumber, yearNumber,
    });

    logger.error("Contract snapshot failed", {
      event: "backup_failed",
      contractId,
      backupId,
      error: msg,
    });

    throw err;
  }
}

// ── Scheduler job ─────────────────────────────────────────────────────────────

/**
 * Run one backup-check tick: snapshot every contract that has no backup
 * for the current ISO week.
 *
 * NOTE: This only covers contracts that already have at least one previous
 * backup.  New contracts are opted-in via the POST /backup/trigger route.
 *
 * @param {Date} [now]
 * @returns {Promise<{ processed: number, succeeded: number, skipped: number, failed: number }>}
 */
export async function runBackupJob(now = new Date()) {
  const { weekNumber, yearNumber } = getIsoWeek(now);
  const contracts = getContractsWithBackups();

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const { contractId } of contracts) {
    try {
      const result = await takeSnapshot(contractId, now);
      if (result === null) {
        skipped++;
      } else {
        succeeded++;
      }
    } catch (err) {
      failed++;
      logger.error("Backup job item failed", {
        contractId,
        weekNumber,
        yearNumber,
        error: err?.message,
      });
    }
  }

  return { processed: contracts.length, succeeded, skipped, failed };
}

/**
 * Start the backup scheduler.  Returns { stop(), interval }.
 *
 * @returns {{ stop: () => void, interval: NodeJS.Timeout }}
 */
export function startBackupScheduler() {
  logger.info("Starting contract backup scheduler", {
    intervalMs: BACKUP_CHECK_INTERVAL_MS,
  });

  const interval = setInterval(async () => {
    try {
      const result = await runBackupJob();
      if (result.processed > 0) {
        logger.info("Backup job tick completed", result);
      }
    } catch (err) {
      logger.error("Backup scheduler tick error", { error: err?.message });
    }
  }, BACKUP_CHECK_INTERVAL_MS);

  interval.unref();

  return {
    stop() {
      clearInterval(interval);
      logger.info("Backup scheduler stopped");
    },
    interval,
  };
}

export const _config = {
  BACKUP_CHECK_INTERVAL_MS,
  UPLOAD_TIMEOUT_MS,
  SNAPSHOT_VERSION,
  DRY_RUN: !PINATA_JWT,
};
