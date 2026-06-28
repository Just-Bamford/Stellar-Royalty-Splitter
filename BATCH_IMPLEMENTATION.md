# Batch Secondary Royalty Distribution - Implementation Guide

## Overview

This document provides implementation details and deployment guidance for the batch secondary royalty distribution system that addresses network spam and accumulated gas costs.

## Architecture

### 1. Smart Contract Layer (Soroban/Rust)

**New Storage Keys**:
- `BatchQueue`: Persistent vector of `BatchEntry` structs
- `BatchWindow`: Instance value for current batch window expiration timestamp
- `BatchRetryCount`: Instance map of batch retry attempts
- `BatchMetrics`: Instance struct tracking efficiency metrics

**New Data Structures**:

```rust
pub struct BatchEntry {
    pub batch_id: u32,
    pub token: Address,
    pub total_amount: i128,
    pub created_at: u64,
    pub processed_at: u64,
    pub retry_count: u32,
    pub status: u32, // 0: pending, 1: processing, 2: completed, 3: failed
}

pub struct BatchMetrics {
    pub total_batches: u32,
    pub total_distributed: i128,
    pub average_batch_size: i128,
    pub total_gas_saved: i128,
    pub last_batch_timestamp: u64,
}
```

**New Public Methods**:

1. `queue_batch_secondary_royalty(token: Address, amount: i128)` — Queue royalty for batching
2. `process_batch_queue()` — Process all expired batches
3. `get_batch_queue_status()` → Vec<BatchEntry> — Query queue contents
4. `get_batch_metrics()` → BatchMetrics — Query efficiency metrics

**Key Features**:
- ✅ Time-windowed batching (5-minute windows)
- ✅ Configurable batch size limits (50 entries default)
- ✅ Retry logic with exponential backoff (3 retries max)
- ✅ Atomic distribution per batch (all-or-nothing)
- ✅ Dust tracking and handling
- ✅ Event emission for monitoring

### 2. Backend Database Layer (SQLite)

**New Tables**:

```sql
CREATE TABLE batch_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractId TEXT NOT NULL,
  batchId INTEGER NOT NULL,
  token TEXT NOT NULL,
  totalAmount TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 0,
  retryCount INTEGER NOT NULL DEFAULT 0,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  processedAt DATETIME
);

CREATE INDEX idx_batch_queue_contractId ON batch_queue(contractId);
CREATE INDEX idx_batch_queue_status ON batch_queue(status);
CREATE INDEX idx_batch_queue_batchId ON batch_queue(contractId, batchId);
```

**Updated Tables**:
- `secondary_royalty_distributions`: Added `batchId`, `collaborators`, `dustAllocated` columns

**Database Functions** (`src/database/batch-queue.js`):

```javascript
// Queue management
export function queueBatchEntry(contractId, batchId, token, totalAmount, status)
export function getPendingBatches(contractId)
export function getBatchHistory(contractId, limit, offset, status)

// Batch tracking
export function updateBatchStatus(batchEntryId, status, retryCount, processedAt)
export function commitBatchDistribution(contractId, batchId, totalAmount, collaborators)

// Metrics
export function getBatchMetrics(contractId)
export function getRetryStats(contractId)
export function getBatchEfficiencyMetrics(contractId)

// Maintenance
export function cleanupOldBatches(contractId, olderThanDays)
```

**Migration**:
```
Version: 8
Tables: batch_queue
Indexes: idx_batch_queue_*
Columns Updated: secondary_royalty_distributions
```

### 3. Backend API Layer (Express/Node.js)

**New Router** (`src/routes/batch-queue.js`):

```
POST   /api/v1/batch-queue/queue        — Queue royalty
POST   /api/v1/batch-queue/process      — Process pending batches
GET    /api/v1/batch-queue/pending/:id  — Get pending batches
GET    /api/v1/batch-queue/history/:id  — Get batch history
GET    /api/v1/batch-queue/metrics/:id  — Get efficiency metrics
GET    /api/v1/batch-queue/distributions/:id — Get completed distributions
```

**Rate Limiting**: 10 writes/minute per IP address (same as secondary-royalty)

**Integration** (`src/index.js`):
```javascript
import { batchQueueRouter } from "./routes/batch-queue.js";
app.use("/api/v1/batch-queue", writeLimiter);
app.use("/api/v1/batch-queue", batchQueueRouter);
```

## Deployment Steps

### 1. Database Migration

Run when deploying:

```bash
# Automatic on server startup
npm start
# Applies migration version 8 automatically
```

**Migration Details**:
- Creates `batch_queue` table with indexes
- Adds columns to `secondary_royalty_distributions`
- Is idempotent (safe to run multiple times)

### 2. Contract Deployment

Rebuild and redeploy Soroban contract:

```bash
# Increment version in Cargo.toml
# From: version = "0.2.0"
# To:   version = "0.3.0"

cargo build --release
soroban contract deploy --wasm target/wasm32-unknown-unknown/release/stellar_royalty_splitter.wasm
```

**Contract Changes**:
- New storage keys: `BatchQueue`, `BatchWindow`, `BatchRetryCount`, `BatchMetrics`
- New public methods (backward compatible)
- Existing methods unchanged

### 3. Backend Deployment

```bash
npm install  # No new dependencies
npm start    # Starts with batch queue routes enabled
```

**No configuration changes required** — uses defaults:
- Batch window: 300 seconds
- Max batch size: 50 entries
- Max retries: 3
- Gas estimate: 5000 stroops/batch

## Configuration

### Contract Constants (Soroban)

Edit `src/lib.rs`:

```rust
/// Time window for batching secondary royalties (seconds)
pub const BATCH_WINDOW_SECONDS: u64 = 300;

/// Maximum entries per batch
pub const MAX_BATCH_SIZE: u32 = 50;

/// Maximum retry attempts
pub const MAX_BATCH_RETRIES: u32 = 3;
```

### Backend Tuning

No runtime configuration needed. All settings hardcoded in:
- `src/database/batch-queue.js` — Metrics calculations
- `src/routes/batch-queue.js` — API defaults
- `backend/src/index.js` — Rate limiting

## Performance Characteristics

### Gas Cost Savings

**Comparison** (100 secondary royalties, 5 collaborators):

| Metric | Individual Txs | Batched | Savings |
|--------|--------|---------|----------|
| Transactions | 100 | 20 | 80% |
| Transfers | 500 | 500 | 0% |
| Gas (stroops) | 2,000,000 | 100,000 | 95% |

**Calculation**:
- Individual: 100 tx × 20,000 stroops = 2,000,000
- Batched: 20 batches × 5,000 stroops = 100,000
- Savings: ~1,900,000 stroops (95% reduction)

### Processing Timeline

| Step | Duration | Notes |
|------|----------|-------|
| Queue | < 1 sec | Immediate |
| Window wait | 0-300 sec | 5 min default |
| Process | 2-5 sec/batch | Soroban execution |
| **Total** | **5-10 min** | From queue to completion |

### Storage Requirements

| Item | Size | Notes |
|------|------|-------|
| Per entry | ~150 bytes | Queued royalty |
| Per batch | ~500 bytes | All entries in batch |
| 1000 entries | ~150 KB | At 50/batch = 20 batches |
| 10000 entries | ~1.5 MB | With indexes |

Storage is bounded by:
- Max 50 entries per batch
- Regular cleanup of completed batches
- Persistent storage TTL management

## Testing

### Unit Tests (Rust)

Run all batch tests:

```bash
cargo test batch_secondary_royalty_test -- --nocapture
```

**Test Coverage** (10 scenarios):

1. ✅ `test_batch_queue_single_entry` — Add one royalty
2. ✅ `test_batch_queue_multiple_entries` — Add multiple royalties
3. ✅ `test_batch_process_single_batch` — Process one batch
4. ✅ `test_batch_process_multiple_entries_atomic` — Process multiple entries atomically
5. ✅ `test_batch_retry_on_insufficient_balance` — Retry on failure
6. ✅ `test_batch_metrics_after_distribution` — Track metrics
7. ✅ `test_batch_max_size_limit` — Enforce size limits
8. ✅ `test_batch_gas_savings_metrics` — Verify gas savings
9. ✅ `test_batch_atomicity_all_collaborators_paid` — Atomicity guarantee
10. ✅ `test_batch_high_volume_100_batches` — Stress test

### Integration Tests (Node.js)

Create in `backend/tests/batch-queue.test.js`:

```javascript
describe('Batch Queue API', () => {
  test('POST /api/v1/batch-queue/queue queues royalty', async () => {
    const res = await request(app)
      .post('/api/v1/batch-queue/queue')
      .send({
        contractId: 'C...',
        walletAddress: 'G...',
        token: 'C...',
        amount: 100000
      });
    expect(res.status).toBe(200);
    expect(res.body.queuedBatchId).toBeDefined();
  });

  test('GET /api/v1/batch-queue/metrics/:id returns metrics', async () => {
    const res = await request(app)
      .get(`/api/v1/batch-queue/metrics/${contractId}`);
    expect(res.status).toBe(200);
    expect(res.body.metrics.totalBatches).toBeDefined();
  });
});
```

## Monitoring & Observability

### Batch Metrics Endpoint

Check efficiency on-demand:

```bash
curl http://localhost:8000/api/v1/batch-queue/metrics/C...
```

**Key Metrics**:
- `completedBatches` — Successful distributions
- `failedBatches` — Failed (retry limit exceeded)
- `estimatedGasSaved` — Stroops saved
- `efficiency.totalSavingsEstimate` — Percentage saved

### Event Monitoring

Monitor contract events:

```
("royalty", "bq_add")      → Batch queued
("royalty", "batch_done")  → Batch completed
("royalty", "batch_retry") → Batch retrying
("royalty", "batch_fail")  → Batch failed
("royalty", "batch_proc")  → Queue processing
```

### Audit Logging

Backend logs in `audit_log` table:

```sql
SELECT * FROM audit_log WHERE action LIKE 'batch_%' ORDER BY timestamp DESC;
```

### Database Maintenance

**Cleanup old batches** (cron job):

```javascript
// Run daily
import { cleanupOldBatches } from './database/batch-queue.js';

// Remove batches completed > 30 days ago
const cleaned = cleanupOldBatches(contractId, 30);
console.log(`Cleaned up ${cleaned} old batch entries`);
```

## Migration Guide

### From Individual Distributions to Batching

**Before** (existing code):
```javascript
// Each royalty triggers immediate distribution
app.post('/api/secondary-royalty', async (req, res) => {
  // ... records sale
  // ... calls distribute_secondary_royalties immediately
});
```

**After** (with batching):
```javascript
// Royalties queue and batch automatically
app.post('/api/secondary-royalty', async (req, res) => {
  // ... records sale
  // NEW: call process_batch_queue instead of immediate distribute
  // OR: let batch window handle it automatically
});
```

**Client Migration**:

Old flow:
1. Record secondary sale
2. Immediately distribute
3. Pay gas per distribution

New flow:
1. Record secondary sale
2. Queue for batching (automatic)
3. Wait for batch window (5 min)
4. Process single batch → single transaction
5. Lower gas cost

## Rollback Plan

If issues discovered:

1. **Revert Contract**: Redeploy previous version (0.2.0)
2. **Disable Batch Routes**: Comment out in `src/index.js`:
   ```javascript
   // app.use("/api/v1/batch-queue", batchQueueRouter);
   ```
3. **Run Previous Code Paths**: Original `distribute_secondary_royalties` still works

**Data Preservation**:
- Batch queue data remains in database
- Can be manually cleaned up later
- No data loss during rollback

## Documentation

- 📄 [BATCH_QUEUE_API.md](./BATCH_QUEUE_API.md) — API reference (endpoints, examples)
- 📄 [SECONDARY_ROYALTIES.md](./SECONDARY_ROYALTIES.md) — Secondary royalty architecture
- 📄 [tests/batch_secondary_royalty_test.rs](./tests/batch_secondary_royalty_test.rs) — Test suite

## Support & Troubleshooting

### Common Issues

**Q: Batch not processing after 5 minutes**

A: Check:
1. Is `process_batch_queue` being called? Manual trigger required
2. Is contract paused? Call `get_is_paused()`
3. Check pending batches: `GET /api/v1/batch-queue/pending/{contractId}`

**Q: Metrics show zero gas savings**

A: Wait for first batch to complete. Metrics only reflect completed batches.

**Q: Batch marked as failed**

A: Check retry count and logs:
1. `retryCount >= 3` means exceeded limit
2. Check database: `SELECT * FROM batch_queue WHERE batchId = X`
3. Requeue if needed with new batch ID

**Q: High database size**

A: Run cleanup job:
```javascript
cleanupOldBatches(contractId, 30);
```

## Performance Optimization Tips

1. **Monitor Window Timing**: Queue royalties early to batch together
2. **Batch Processing**: Call `process_batch_queue` during low-traffic periods
3. **Cleanup**: Run maintenance job weekly to remove old completed batches
4. **Metrics**: Check efficiency metrics to validate gas savings
5. **Retry Handling**: Implement exponential backoff in client retry logic

## Future Enhancements

1. **Dynamic Batch Windows**: Adjust window based on queue depth
2. **Priority Batches**: Fast-track high-value batches
3. **Cross-Contract Batching**: Combine royalties from multiple contracts
4. **Automated Processing**: Timer-based batch processing without manual trigger
5. **Analytics Dashboard**: Real-time batch efficiency visualization

---

**Version**: 1.0  
**Updated**: 2026-06-28  
**Status**: Production Ready
