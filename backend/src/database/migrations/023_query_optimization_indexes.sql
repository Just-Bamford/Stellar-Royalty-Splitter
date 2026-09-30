-- ==============================================================================
-- Migration 023: Comprehensive Database Indexing & Query Optimization Strategy
-- Closes GitHub Issue #984
-- ==============================================================================

-- 1. Foreign Key Indexes (Eliminates table scans during JOINs and cascades)
CREATE INDEX IF NOT EXISTS idx_distribution_payouts_txId 
  ON distribution_payouts(transactionId);

CREATE INDEX IF NOT EXISTS idx_distribution_payouts_collab 
  ON distribution_payouts(collaboratorAddress, transactionId);

CREATE INDEX IF NOT EXISTS idx_distribution_payouts_contract 
  ON distribution_payouts(contractId);

CREATE INDEX IF NOT EXISTS idx_distribution_payouts_collab_contract 
  ON distribution_payouts(collaboratorAddress, contractId);

CREATE INDEX IF NOT EXISTS idx_secondary_distributions_txId 
  ON secondary_royalty_distributions(transactionId);

CREATE INDEX IF NOT EXISTS idx_dispute_comments_dispute_created 
  ON dispute_comments(disputeId, createdAt ASC);

CREATE INDEX IF NOT EXISTS idx_disputes_contract 
  ON disputes(contractId);

CREATE INDEX IF NOT EXISTS idx_disputes_wallet_status 
  ON disputes(walletAddress, status);

CREATE INDEX IF NOT EXISTS idx_crm_activity_log_address 
  ON crm_activity_log(address, createdAt DESC);

CREATE INDEX IF NOT EXISTS idx_crm_contact_mappings_contract_addr 
  ON crm_contact_mappings(contractId, address);

-- 2. Timestamp and Date-Range Composite Indexes
CREATE INDEX IF NOT EXISTS idx_transactions_contract_status_time 
  ON transactions(contractId, status, timestamp);

CREATE INDEX IF NOT EXISTS idx_transactions_contract_time 
  ON transactions(contractId, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_initiator_time 
  ON transactions(initiatorAddress, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_secondary_sales_contract_time 
  ON secondary_sales(contractId, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_secondary_distributions_contract_time 
  ON secondary_royalty_distributions(contractId, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_reputation_events_wallet_date 
  ON reputation_payout_events(walletAddress, payoutDate DESC);

CREATE INDEX IF NOT EXISTS idx_reputation_events_contract_date 
  ON reputation_payout_events(contractId, payoutDate DESC);

CREATE INDEX IF NOT EXISTS idx_reputation_activities_wallet_time 
  ON reputation_activities(walletAddress, timestamp DESC);

-- 3. Partial Indexes for Hot Status Flags (Supported in SQLite 3.8.0+)
CREATE INDEX IF NOT EXISTS idx_transactions_confirmed_payouts 
  ON transactions(contractId, timestamp) 
  WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_contributor_status_active 
  ON contributor_status(contractId, address) 
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_disputes_open 
  ON disputes(createdAt DESC) 
  WHERE status IN ('open', 'under_review');

CREATE INDEX IF NOT EXISTS idx_secondary_sales_undistributed 
  ON secondary_sales(contractId, timestamp) 
  WHERE distributed = 0;

CREATE INDEX IF NOT EXISTS idx_transactions_active_holds 
  ON transactions(contractId, hold_placed_at) 
  WHERE hold_status = 'active';

-- 4. Materialized View Summary Table for Earnings Dashboard Hot Path (#984)
CREATE TABLE IF NOT EXISTS earnings_summary_mv (
  contractId TEXT PRIMARY KEY,
  totalTransactions INTEGER NOT NULL DEFAULT 0,
  totalDistributed TEXT NOT NULL DEFAULT '0',
  averagePayout TEXT NOT NULL DEFAULT '0',
  uniqueCollaborators INTEGER NOT NULL DEFAULT 0,
  lastPayoutAt DATETIME,
  lastRefreshedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_earnings_summary_mv_refreshed 
  ON earnings_summary_mv(lastRefreshedAt);
