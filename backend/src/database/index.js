/**
 * Database module index ÔÇö re-exports all database functions.
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
  recordHealthSnapshot,
  pruneHealthHistory,
  getHealthHistory,
  getSLAStats,
  checkDatabase,
} from "./core.js";

// Transaction tracking
export {
  recordTransaction,
  updateTransactionHash,
  updateTransactionStatus,
  addDistributionPayout,
  findPayoutsByAmount,
  getTransactionCount,
  getTransactionHistory,
  getTransactionHistoryCursor,
  getTransactionDetails,
  getTransactionById,
  getRetryEligibleTransactions,
  RETRY_BACKOFF_MS,
  MAX_RETRY_COUNT,
} from "./transactions.js";

// Webhooks (#295)
export {
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  updateWebhookRetryState,
  getWebhooksDueForRetry,
  resetWebhookRetryCount,
} from "./webhooks.js";

// Audit logging
export { getAuditLog, addAuditLog, countAuditLog } from "./audit.js";

// Centralized application logs (#874)
export {
  appendApplicationLog,
  queryApplicationLogs,
  countApplicationLogs,
  pruneApplicationLogs,
  evaluateLogAlerts,
  DEFAULT_RETENTION_DAYS,
} from "./application-logs.js";

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
export {
  getAnalyticsData,
  getContributorEarningsHistory,
  getContributorEarningsEvents,
  getContributorContracts,
} from "./analytics.js";

// Payment preferences (#584)
export { getPaymentPreference, savePaymentPreference } from "./payment-preferences.js";

// Transaction fee display (#606)
export { recordTransactionFee, getTransactionFee, getFeesByContract } from "./transaction-fees.js";

// Notification preferences (#605)
export {
  getNotificationPreferences,
  saveNotificationPreferences,
} from "./notification-preferences.js";

// Contributor verification (#602)
export {
  getVerification,
  upsertVerification,
  getVerificationsByStep,
  VERIFICATION_STEPS,
  VERIFICATION_STATUSES,
} from "./contributor-verification.js";

// KYC provider integration hooks (#598)
export {
  recordKycEvent,
  getKycEventBySession,
  getKycEventsByWallet,
  countKycEventsByWallet,
  linkKycSessionToWallet,
  KYC_PROVIDERS,
  KYC_EVENT_OUTCOMES,
} from "./kyc.js";

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

// Disputes / ticket system (#607, enhanced #961)
export {
  createDispute,
  getDisputeByTicketId,
  getDisputesByWallet,
  countDisputesByWallet,
  getAllDisputes,
  countAllDisputes,
  updateDisputeStatus,
  addDisputeComment,
  getDisputeComments,
  addDisputeEvidence,
  getDisputeEvidence,
  storeDisputeAnalysis,
  getDisputeAnalysis,
  addMediationRecommendation,
  getMediationRecommendations,
  updateMediationRecommendationStatus,
  getDisputeStatistics,
} from "./disputes.js";

// API key rate-limit usage tracking (#608)
export {
  DEFAULT_AUTH_LIMIT_PER_MINUTE,
  DEFAULT_IP_LIMIT_PER_MINUTE,
  ALERT_THRESHOLD_FRACTION,
  HISTORY_RETENTION_MINUTES,
  recordApiKeyRequest,
  getApiKeyCurrentUsage,
  getApiKeyHistory,
  getAllApiKeysUsage,
  setApiKeyLimit,
  registerApiKey,
  getApproachingLimitAlerts,
} from "./rate-limit.js";

// Referral tracking (#603)
export {
  DEFAULT_REFERRAL_BONUS_STROOPS,
  generateReferralLink,
  getReferralLinkByWallet,
  getReferralLinkByCode,
  registerReferral,
  activateReferral,
  getReferralByReferred,
  getReferralsByReferrer,
  countReferralsByReferrer,
  awardReferralBonus,
  getBonusesByReferrer,
  getReferralDashboard,
  getAllReferrals,
  countAllReferrals,
} from "./referrals.js";

// Contract state snapshots (#613)
export {
  ensureSnapshotTable,
  createSnapshot,
  listSnapshots,
  getSnapshot,
  verifySnapshotIntegrity,
  countSnapshots,
  getAllSnapshots,
  pruneSnapshots,
} from "./contract-snapshots.js";

// Contributor communication history (#612)
export {
  ensureCommunicationsTable,
  recordCommunication,
  getCommunicationsByWallet,
  getCommunicationsByContract,
  searchCommunications,
  addInternalNote,
  getCommunicationTimeline,
  countCommunications,
} from "./contributor-communications.js";

// Reusable royalty split templates (#652)
export { createTemplate, listTemplates, getTemplateById, deleteTemplate } from "./templates.js";

// Contributor metrics (#600)
export {
  getCachedMetrics,
  recomputeMetrics,
  getOrComputeMetrics,
  recomputeContractMetrics,
  getContractLeaderboard,
} from "./contributor-metrics.js";

// Contributor status (#593)
export {
  getContributorStatus,
  listContributorStatuses,
  setContributorStatus,
  isContributorBlocked,
} from "./contributor-status.js";

// Transaction finality tracking (#finality)
export {
  createFinalityRecord,
  setFinalityTxHash,
  incrementPollAttempt,
  markFinalityConfirmed,
  markFinalityFailed,
  markFinalityTimeout,
  getFinalityByTransactionId,
  getFinalityByTxHash,
  getPendingFinalityRecords,
  deleteOldFinalityRecords,
} from "./transaction-finality.js";

// Connection health monitoring (#496)
export {
  checkConnectionHealth,
  checkConnectionHealthAsync,
  attemptReconnection,
  startHealthMonitor,
  stopHealthMonitor,
  getHealthStatus,
  getHealthMetrics,
  resetHealthMonitorState,
} from "./health-monitor.js";

// Salesforce CRM integration (#939)
export {
  CRM_PROVIDER,
  CRM_SYNC_STATES,
  CRM_ACTIVITY_STATES,
  CRM_SYNC_DIRECTIONS,
  getConnection,
  saveConnection,
  updateConnectionTokens,
  disconnectConnection,
  getSyncStatus,
  startSync,
  incrementSyncProgress,
  finishSync,
  getContactMappingByAddress,
  findContactMappingByExternalId,
  listContactMappings,
  upsertContactMapping,
  recordCrmActivity,
  listCrmActivities,
  listKnownCollaborators,
} from "./crm-sync-status.js";

// Tax compliance forms (#950)
export {
  TAX_FORM_TYPES,
  TAX_FORM_STATUSES,
  SUPPORTED_COUNTRIES,
  IRS_1099_THRESHOLD_USD,
  CRA_T4A_THRESHOLD_USD,
  createTaxForm,
  getTaxForm,
  getLatestTaxForm,
  listTaxForms,
  countTaxForms,
  voidTaxForm,
  getTaxYearSummary,
} from "./tax-forms.js";

// Reputation and trust score system (#962)
export {
  initializeReputationTables,
  getOrCreateReputation,
  recordPayoutEvent,
  recordReputationActivity,
  calculateTrustScore,
  updateReputationAfterPayout,
  getReputationDetails,
  getTopCollaborators,
  getCollaboratorsByTier,
  countCollaboratorsByTier,
  recalculateAllTrustScores,
  getReputationStatistics,
} from "./reputation.js";

// Advanced search API (#971)
export {
  initializeSearchTables,
  indexCollaborator,
  indexTransaction,
  indexDispute,
  recordSearch,
  searchCollaborators,
  searchTransactions,
  searchDisputes,
  searchAll,
  semanticSearch,
  advancedSearch,
  getSearchSuggestions,
  getTrendingSearches,
  getSearchStatistics,
  rebuildSearchIndexes,
} from "./search.js";

// Zero-knowledge proof privacy system (#972)
export {
  initializeZKPrivacyTables,
  storeDistributionProof,
  getDistributionProof,
  getDistributionProofs,
  markProofVerified,
  storeNullifier,
  isNullifierUsed,
  issueAnonymousCredential,
  getAnonymousCredential,
  getCredentialsByWallet,
  markCredentialUsed,
  revokeCredential,
  getZKAuditLog,
  getZKPrivacyStatistics,
} from "./zk-privacy.js";

// Query optimizer & batching utilities (#984)
export {
  explainQueryPlan,
  batchGetContributorStatus,
  batchGetTransactionDetails,
  batchGetDisputeComments,
  batchGetCollaboratorReputation,
  refreshEarningsSummaryMV,
  getOptimizedEarningsSummary,
} from "../services/query-optimizer.js";

// Real-time collaborative contract editor (#959)
export {
  createEditSession,
  extendEditSession,
  releaseEditSession,
  getActiveEditSessions,
  recordContractEdit,
  getContractEditHistory,
  applyOperationalTransform,
  getFieldVersion,
  cleanupExpiredSessions,
} from "./collaborative-editor.js";

// Dynamic royalty oracle with ML predictions (#960)
export {
  storePrediction,
  getLatestPrediction,
  getPredictionHistory,
  storeModelMetadata,
  getLatestModelMetadata,
  getModelMetadata,
  storeMarketData,
  getLatestMarketData,
  getMarketDataHistory,
  calculatePredictionAccuracy,
  getMarketTrends,
} from "./oracle.js";

// Time-locked vesting contracts (#983)
export {
  createVestingSchedule,
  calculateVestedAmount,
  releaseVestedTokens,
  getVestingSchedule,
  getVestingSchedulesByBeneficiary,
  getVestingSchedulesByContract,
  getVestingReleaseHistory,
  getSchedulesWithReleasableTokens,
  cancelVestingSchedule,
  getVestingStatistics,
} from "./vesting.js";

// Enhanced audit logging with hash-chain (#986)
export {
  addAuditEntry,
  verifyAuditChainIntegrity,
  getAuditEntries,
  getAuditStatistics,
  exportAuditLogJSON,
  exportAuditLogCSV,
  getComplianceReport,
  searchAuditLog,
} from "./audit-enhanced.js";

// Default export for backwards compatibility
import { db } from "./core.js";
export default db;

// Contract backups and disaster recovery (#993)
export {
  getIsoWeek,
  createBackupRecord,
  markBackupUploading,
  markBackupCompleted,
  markBackupFailed,
  recordDrillResult,
  getBackupById,
  listBackups,
  countBackups,
  getLatestBackup,
  backupExistsForWeek,
  getContractsWithBackups,
  pruneOldBackups,
} from "./backups.js";

// Distribution schedules and batch execution (#991)
export {
  createSchedule,
  getScheduleById,
  listSchedulesByContract,
  countSchedulesByContract,
  updateSchedule,
  deleteSchedule,
  pauseSchedule,
  resumeSchedule,
  markScheduleRun,
  getDueSchedules,
  createBatchExecution,
  markBatchRunning,
  markBatchCompleted,
  markBatchFailed,
  recordBatchItem,
  getBatchExecution,
  listBatchExecutionsBySchedule,
  listRecentBatchExecutions,
} from "./schedules.js";

// Rights Management System
export {
  initializeRightsTables,
  clearRightsTables,
  createRightRecord,
  getRightById,
  getRightsByContract,
  getRightsByOwner,
  updateRightRecord,
  deleteRightRecord,
  upsertRightMetadataRecord,
  getRightMetadataRecord,
  createVerificationProofRecord,
  getVerificationProofById,
  getVerificationProofsRecord,
  updateVerificationProofStatusRecord,
  addRightHistoryRecord,
  getRightHistoryRecord,
  linkRightToDisputeRecord,
  getRightsForDisputeRecord,
  getDisputesForRightRecord,
} from "./rights-schema.js";

// DAO Treasury Management (#1076)
export {
  initializeTreasuryTables,
  clearTreasuryTables,
  createCategoryRecord,
  getCategoryById,
  getCategoryByName,
  listCategories,
  updateCategoryRecord,
  deleteCategoryRecord,
  createAllocationRecord,
  getAllocationById,
  listAllocations,
  createExpenseRecord,
  getExpenseById,
  listExpenses as listTreasuryExpenseRecords,
  updateExpenseRecord,
  deleteExpenseRecord,
  createApprovalRecord,
  listApprovalsByExpense,
  createReceiptRecord,
  listReceiptsByExpense,
} from "./treasury-schema.js";

