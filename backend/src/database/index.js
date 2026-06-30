/**
 * Database module index — re-exports all database functions.
 * Provides backwards compatibility while organizing code into focused submodules.
 */

// Core database setup
export {
  db,
  checkpointDatabase,
  closeDatabase,
  countWrite,
  initializeDatabase,
  getMigrationVersion,
} from "./core.js";

// Transaction tracking
export {
  recordTransaction,
  updateTransactionHash,
  updateTransactionStatus,
  addDistributionPayout,
  getTransactionCount,
  getTransactionHistory,
  getTransactionDetails,
  getTransactionById,
} from "./transactions.js";

// Webhooks (#295)
export { registerWebhook, listWebhooks, deleteWebhook } from "./webhooks.js";

// Audit logging
export { getAuditLog, addAuditLog } from "./audit.js";

// Secondary royalties
export {
  recordSecondarySale,
  getSecondarySales,
  countSecondarySales,
  markSalesDistributed,
  recordSecondaryRoyaltyDistribution,
  getSecondaryRoyaltyDistributions,
  getRoyaltyStatistics,
} from "./secondary-royalties.js";

// Analytics
export { getAnalyticsData } from "./analytics.js";

// Contract event archival
export {
  DEFAULT_ARCHIVE_BATCH_SIZE,
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  archiveContractEvents,
  getArchiveCutoffDate,
  getArchivePolicy,
  getArchivedEventCount,
  getArchivedEvents,
  updateArchivePolicy,
} from "./archive.js";

// Default export for backwards compatibility
import { db } from "./core.js";
export default db;
