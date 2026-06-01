/**
 * Database module index — re-exports all database functions.
 * Provides backwards compatibility while organizing code into focused submodules.
 */

// Core database setup
export { db, countWrite, initializeDatabase, getMigrationVersion } from "./core.js";

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

// Default export for backwards compatibility
import { db } from "./core.js";
export default db;
