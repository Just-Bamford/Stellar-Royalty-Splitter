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
  computeAuditEntryHash,
  verifyAuditLogIntegrity,
  verifyAuditLogOnStartup,
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

// Webhooks (#295, #401, #428)
export {
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  enqueueDeadLetter,
  listDeadLetters,
  listAllPendingDeadLetters,
  markDeadLetterRetried,
  deleteOldDeadLetters,
} from "./webhooks.js";

// Audit logging
export { getAuditLog, addAuditLog, exportAuditLogs } from "./audit.js";

// Collaborator lookup
export { lookupCollaborators } from "./collaborator-lookup.js";

// Request nonce dedup (#421)
export { recordNonceIfNew } from "./request-nonces.js";

// API keys (#420)
export { createApiKey, listApiKeys, revokeApiKey, findActiveKeyByRawKey } from "./api-keys.js";

// Secondary royalties
export {
  recordSecondarySale,
  getSecondarySales,
  countSecondarySales,
  markSalesDistributed,
  recordSecondaryRoyaltyDistribution,
  getSecondaryRoyaltyDistributions,
  getRoyaltyStatistics,
  applyLargestRemainder,
  commitSecondaryDistributionAtomic,
} from "./secondary-royalties.js";

// Analytics
export { getAnalyticsData } from "./analytics.js";

// Query profiling (#500)
export { getQueryProfilerMetrics, resetQueryProfilerMetrics } from "../query-profiler.js";

// Default export for backwards compatibility
import { db } from "./core.js";
export default db;

