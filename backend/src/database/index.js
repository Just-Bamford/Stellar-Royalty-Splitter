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
  getRetryEligibleTransactions,
  markTransactionRetrying,
  markTransactionRetryExhausted,
  getRetryExhaustedTransactions,
  getTransactionRetryCount,
  RETRY_BACKOFF_MS,
  MAX_RETRY_COUNT,
} from "./transactions.js";

// Webhooks (#295)
export { registerWebhook, listWebhooks, deleteWebhook } from "./webhooks.js";

// Audit logging
export { getAuditLog, addAuditLog, countAuditLog } from "./audit.js";

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

// Payment preferences (#584)
export { getPaymentPreference, savePaymentPreference } from "./payment-preferences.js";

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

// CSV bulk import (#597)
export {
  createCsvImport,
  markImportSuccess,
  markImportFailed,
  getCsvImport,
  getCsvImportsByContract,
  addImportResult,
  getImportResults,
  getImportSummary,
} from "./csv-import.js";

// Contributor tax information (#595)
export {
  getContributorTax,
  upsertContributorTax,
  getTaxComplianceReport,
  getContributorsMissingTaxInfo,
  getAllWalletAddresses,
} from "./contributor-tax.js";

// Real-time notifications (#594)
export {
  createNotification,
  getNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  getNotificationPreference,
  upsertNotificationPreference,
  createSystemNotification,
} from "./notifications.js";

// Payment hold/release system (#596)
export {
  placeHold,
  releaseHold,
  approveHoldRelease,
  getTransactionWithHold,
  getHeldTransactions,
  getAllHeldTransactions,
  getHoldAuditTrail,
  getTransactionsPendingHoldRelease,
} from "./payment-holds.js";

// Email digest (#569)
export {
  subscribeEmailDigest,
  getSubscriberByToken,
  getSubscriberByWallet,
  unsubscribeByEmailDigest,
  unsubscribeByWallet,
  updateSubscriberPreferences,
  getAllEnabledSubscribers,
  getSubscribersDueForDigest,
  wasDigestSentThisWeek,
  logDigestSent,
  logDigestFailed,
  getDigestHistory,
  getEarningsForWeek,
} from "./email-digest.js";

// KYC integration (#598)
export {
  upsertKycStatus,
  getKycStatus,
  logKycEvent,
  getKycEvents,
  getAllKycEvents,
} from "./kyc.js";

// Payment schedule templates (#599)
export {
  createPaymentSchedule,
  getPaymentSchedule,
  getSchedulesByContract,
  getAllEnabledSchedules,
  getDueSchedules,
  updatePaymentSchedule,
  markScheduleRun,
  deletePaymentSchedule,
  logScheduledDistribution,
  getScheduleHistory,
  computeNextRunAt,
} from "./payment-schedules.js";

// Contributor performance metrics (#600)
export {
  computeAndSavePerformance,
  getContributorPerformance,
  getContributorProfile,
  getContractPerformanceLeaderboard,
  computeLiveMetrics,
} from "./contributor-performance.js";

// Compliance reports (#601)
export {
  saveComplianceReport,
  getComplianceReport,
  listComplianceReports,
  getComplianceScheduleConfig,
  updateComplianceScheduleConfig,
} from "./compliance-reports.js";

// Default export for backwards compatibility
import { db } from "./core.js";
export default db;
