# Batch Secondary Royalty Distribution API

## Overview

The Batch Secondary Royalty Distribution system addresses network spam and accumulated gas costs by grouping multiple secondary royalty distributions into time-windowed batches, processing each batch in a single transaction.

**Problem**: Each secondary royalty distribution creates a separate transaction per collaborator, resulting in:
- Network spam when distributions are frequent
- Accumulated gas costs for multiple small transactions
- Inefficient use of Stellar network resources

**Solution**: 
- Batch multiple secondary royalties into 5-minute time windows
- Process each batch atomically in a single transaction
- Distribute to all collaborators in parallel
- Track batch metrics and efficiency

## Core Concepts

### Batch Window
- **Duration**: 5 minutes (300 seconds)
- **Behavior**: All secondary royalties queued within a window are combined into one batch
- **Processing**: Batch is ready for distribution once the window expires

### Batch Queue
- **Storage**: Queued batches in persistent contract storage + backend database
- **Max Size**: 50 entries per batch to prevent unbounded queue growth
- **Status Values**: 
  - `0`: Pending (waiting for window expiration)
  - `1`: Processing (currently executing distribution)
  - `2`: Completed (successfully distributed)
  - `3`: Failed (exceeded max retry attempts)

### Atomicity
- Each batch processes all collaborators in a **single transaction**
- All-or-nothing: Either entire batch succeeds or fails together
- No partial distributions

## API Endpoints

### 1. Queue Batch Secondary Royalty

**POST** `/api/v1/batch-queue/queue`

Queue a secondary royalty for batch processing. The royalty will be combined with others within the same 5-minute window and distributed atomically.

**Request Body**:
```json
{
  "contractId": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC",
  "walletAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADQ",
  "token": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC",
  "amount": 100000
}
```

**Response** (200 OK):
```json
{
  "queuedBatchId": 1719590400,
  "entryId": 42,
  "windowExpires": 1719590700,
  "estimatedProcessTime": "5 minutes",
  "amount": 100000
}
```

**Parameters**:
- `contractId` (string, required): Contract address (56 chars)
- `walletAddress` (string, required): Admin wallet address (56 chars)
- `token` (string, required): Token address for royalty (56 chars)
- `amount` (number, required): Amount to queue in token's smallest units

**Response Fields**:
- `queuedBatchId`: Batch identifier (timestamp-based)
- `entryId`: Database row ID for tracking
- `windowExpires`: Unix timestamp when batch window closes (seconds)
- `estimatedProcessTime`: Human-readable window duration
- `amount`: Queued amount

**Rate Limit**: 10 requests/minute per IP address

---

### 2. Process Batch Queue

**POST** `/api/v1/batch-queue/process`

Trigger processing of all pending batches that have reached window expiration. This endpoint returns an unsigned transaction XDR that must be signed by the admin wallet.

**Request Body**:
```json
{
  "contractId": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC",
  "walletAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADQ"
}
```

**Response** (200 OK):
```json
{
  "xdr": "AAAAAgAAAABmA7d...[truncated]",
  "action": "process_batch_queue",
  "note": "Sign and submit transaction to process queued batches"
}
```

**Response Fields**:
- `xdr` (string): Unsigned transaction envelope XDR
- `action` (string): Action being performed
- `note` (string): Instructions for client

**Transaction Details**:
- Calls contract method: `process_batch_queue()`
- Requires: Admin authorization
- Gas estimate: ~5-10k stroops per batch (vs 20-40k for individual distributions)

---

### 3. Get Pending Batches

**GET** `/api/v1/batch-queue/pending/:contractId`

Retrieve all pending batches (status = 0) awaiting window expiration.

**Query Parameters**:
- `limit` (number, default: 50): Max results to return
- `offset` (number, default: 0): Pagination offset

**Response** (200 OK):
```json
{
  "pending": [
    {
      "id": 1,
      "batchId": 1719590400,
      "token": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC",
      "totalAmount": "100000",
      "status": 0,
      "retryCount": 0,
      "createdAt": "2026-06-28T12:00:00Z"
    }
  ],
  "count": 1,
  "offset": 0,
  "limit": 50
}
```

**Response Fields**:
- `pending`: Array of pending batch entries
- `count`: Total pending batches
- `offset`: Pagination offset
- `limit`: Pagination limit

---

### 4. Get Batch History

**GET** `/api/v1/batch-queue/history/:contractId`

Retrieve batch processing history with optional status filtering.

**Query Parameters**:
- `limit` (number, default: 50): Max results to return
- `offset` (number, default: 0): Pagination offset
- `status` (number, optional): Filter by status (0=pending, 1=processing, 2=completed, 3=failed)

**Response** (200 OK):
```json
{
  "history": [
    {
      "id": 1,
      "batchId": 1719590400,
      "token": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC",
      "totalAmount": "250000",
      "status": 2,
      "retryCount": 0,
      "createdAt": "2026-06-28T12:00:00Z",
      "processedAt": "2026-06-28T12:05:30Z"
    }
  ],
  "count": 1,
  "offset": 0,
  "limit": 50,
  "statusFilter": 2
}
```

**Status Values**:
- `0`: Pending (awaiting window expiration)
- `1`: Processing (currently executing)
- `2`: Completed (successfully distributed)
- `3`: Failed (exceeded retry limit)

---

### 5. Get Batch Metrics

**GET** `/api/v1/batch-queue/metrics/:contractId`

Retrieve batch processing efficiency metrics and gas savings estimates.

**Response** (200 OK):
```json
{
  "metrics": {
    "totalBatches": 10,
    "completedBatches": 8,
    "failedBatches": 0,
    "totalDistributed": "2500000",
    "averageBatchSize": "312500",
    "lastBatchTimestamp": "2026-06-28T12:15:30Z",
    "estimatedGasSaved": "40000",
    "efficiency": {
      "avgRecipientsPerBatch": 5,
      "estimatedSavingsPerBatch": "20000",
      "totalSavingsEstimate": "160000"
    }
  }
}
```

**Metrics Explained**:

- `totalBatches`: Number of batches processed (all statuses)
- `completedBatches`: Successfully distributed batches
- `failedBatches`: Batches exceeding retry limit
- `totalDistributed`: Total amount successfully distributed (stroops)
- `averageBatchSize`: Average amount per completed batch
- `lastBatchTimestamp`: When last batch was processed
- `estimatedGasSaved`: Estimated stroops saved vs individual transactions

**Efficiency Calculation**:
```
Gas savings per batch = (n - 1) × 5000 stroops
Where n = average recipients per contract

Total savings = completed batches × savings per batch
```

---

### 6. Get Batch Distributions

**GET** `/api/v1/batch-queue/distributions/:contractId`

Retrieve completed batch distributions with detailed payout information.

**Query Parameters**:
- `limit` (number, default: 50): Max results to return
- `offset` (number, default: 0): Pagination offset
- `batchId` (number, optional): Filter by specific batch ID

**Response** (200 OK):
```json
{
  "distributions": [
    {
      "id": 1,
      "batchId": 1719590400,
      "totalAmount": "250000",
      "collaborators": [
        {
          "address": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADQ",
          "amount": "125000",
          "dustReceived": 0
        },
        {
          "address": "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBY",
          "amount": "125000",
          "dustReceived": 0
        }
      ],
      "transactionId": "abc123def456...",
      "processedAt": "2026-06-28T12:05:30Z"
    }
  ],
  "count": 1,
  "offset": 0,
  "limit": 50,
  "batchIdFilter": null
}
```

**Collaborator Fields**:
- `address`: Collaborator wallet address
- `amount`: Amount received (stroops)
- `dustReceived`: Rounding dust allocated to this collaborator (0 or 1)

---

## Contract Methods (Soroban)

### queue_batch_secondary_royalty

Queue a secondary royalty for batch processing.

**Signature**:
```rust
pub fn queue_batch_secondary_royalty(env: Env, token: Address, amount: i128)
```

**Parameters**:
- `token`: Token address for the royalty
- `amount`: Amount to queue (must be > 0)

**Authorization**: Requires admin signature

**Events Emitted**:
```
("royalty", "bq_add") → (EVENT_VERSION, sequence, batch_id, amount)
```

**Panics**:
- `"contract paused"` — if contract is paused
- `"amount must be positive"` — if amount ≤ 0

---

### process_batch_queue

Process all pending batches that have reached window expiration.

**Signature**:
```rust
pub fn process_batch_queue(env: Env)
```

**Authorization**: Requires admin signature

**Behavior**:
1. Iterates through all pending batches
2. Checks if batch window has expired
3. For expired batches:
   - Distributes to all collaborators in single transaction
   - Marks batch as completed (status = 2)
   - Updates metrics with gas savings
4. On distribution failure:
   - Retries up to 3 times (MAX_BATCH_RETRIES)
   - Marks as failed (status = 3) if max retries exceeded

**Events Emitted**:
```
("royalty", "batch_done") → (EVENT_VERSION, sequence, batch_id, amount)
("royalty", "batch_retry") → (EVENT_VERSION, sequence, batch_id, retry_count)
("royalty", "batch_fail") → (EVENT_VERSION, sequence, batch_id)
("royalty", "batch_proc") → (EVENT_VERSION, sequence, processed_count)
("batch_xfer") → (EVENT_VERSION, sequence, recipient_address, payout_amount)
```

**Panics**:
- `"contract paused"` — if contract is paused
- `"invalid share total"` — if share map doesn't total 10,000

---

### get_batch_queue_status

Retrieve current batch queue contents.

**Signature**:
```rust
pub fn get_batch_queue_status(env: Env) -> Vec<BatchEntry>
```

**Returns**: Array of BatchEntry structs with all queued batches

**BatchEntry Fields**:
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
```

---

### get_batch_metrics

Retrieve batch processing metrics.

**Signature**:
```rust
pub fn get_batch_metrics(env: Env) -> BatchMetrics
```

**Returns**: BatchMetrics struct

**BatchMetrics Fields**:
```rust
pub struct BatchMetrics {
    pub total_batches: u32,
    pub total_distributed: i128,
    pub average_batch_size: i128,
    pub total_gas_saved: i128,
    pub last_batch_timestamp: u64,
}
```

---

## Usage Flow

### Step 1: Queue Multiple Secondary Royalties

```bash
# Queue royalty 1
curl -X POST http://localhost:8000/api/v1/batch-queue/queue \
  -H "Content-Type: application/json" \
  -d '{
    "contractId": "C...",
    "walletAddress": "G...",
    "token": "C...",
    "amount": 100000
  }'

# Queue royalty 2 (within 5-minute window)
curl -X POST http://localhost:8000/api/v1/batch-queue/queue \
  -H "Content-Type: application/json" \
  -d '{
    "contractId": "C...",
    "walletAddress": "G...",
    "token": "C...",
    "amount": 50000
  }'
```

### Step 2: Wait for Batch Window to Expire

Wait at least 5 minutes (300 seconds) or trigger manually after sufficient royalties accumulate.

### Step 3: Process Batch

```bash
curl -X POST http://localhost:8000/api/v1/batch-queue/process \
  -H "Content-Type: application/json" \
  -d '{
    "contractId": "C...",
    "walletAddress": "G..."
  }'
```

This returns an unsigned transaction XDR. Sign with admin private key and submit to Stellar network.

### Step 4: Monitor Batch Progress

```bash
# Check pending batches
curl http://localhost:8000/api/v1/batch-queue/pending/C...

# Get processing history
curl http://localhost:8000/api/v1/batch-queue/history/C...

# View efficiency metrics
curl http://localhost:8000/api/v1/batch-queue/metrics/C...

# Retrieve completed distributions
curl http://localhost:8000/api/v1/batch-queue/distributions/C...
```

---

## Configuration

### Batch Window Duration

**Default**: 300 seconds (5 minutes)

Set in Soroban contract (`src/lib.rs`):
```rust
pub const BATCH_WINDOW_SECONDS: u64 = 300;
```

### Batch Size Limit

**Default**: 50 entries per batch

Set in Soroban contract:
```rust
pub const MAX_BATCH_SIZE: u32 = 50;
```

### Retry Limit

**Default**: 3 retry attempts

Set in Soroban contract:
```rust
pub const MAX_BATCH_RETRIES: u32 = 3;
```

### Estimated Gas Savings

**Default**: 5000 stroops per batch (assumes ~5 recipients)

Calculation in backend (`src/database/batch-queue.js`):
```javascript
estimatedSavingsPerBatch = (avgRecipientsPerBatch - 1) * 5000;
```

---

## Error Handling

### Insufficient Balance

If a batch's total amount exceeds available token balance:
- Batch enters retry state
- Retried up to 3 times
- If still failing, marked as failed (status = 3)

**Action**: Ensure sufficient token balance or wait for balance increase.

### Share Map Errors

If share map doesn't total 10,000 basis points:
- Batch processing halts with error
- No partial distributions
- Entire batch fails safely

**Action**: Update share allocations to sum to 10,000 before reprocessing.

### Contract Paused

If contract is paused:
- Cannot queue new batches
- Cannot process queued batches

**Action**: Unpause contract before proceeding.

---

## Performance Considerations

### Network Efficiency

**Scenario**: 100 secondary royalties, 5 collaborators per contract

**Without Batching** (100 separate transactions):
- Transactions: 100
- Transfers: 500 (5 per transaction)
- Estimated gas: 100 × 20,000 = 2,000,000 stroops

**With Batching** (20 batches, 5 per batch):
- Transactions: 20 (5 batches × 4 calls each)
- Transfers: 500 (combined in batches)
- Estimated gas: 20 × 5,000 = 100,000 stroops
- **Savings**: ~95% reduction

### Batch Processing Time

- **Queuing**: Immediate (< 1 second)
- **Window Wait**: Up to 5 minutes
- **Processing**: 2-5 seconds per batch
- **Total**: 5-10 minutes from queue to completion

### Storage Impact

- **Per Entry**: ~150 bytes
- **Per Batch**: ~500 bytes
- **Total Capacity**: 50 entries per batch limits growth

---

## Testing

Run comprehensive batch tests:

```bash
cargo test --test batch_secondary_royalty_test -- --test-threads=1 --nocapture
```

**Test Coverage** (10+ scenarios):

1. ✅ Single entry queueing
2. ✅ Multiple entries accumulate
3. ✅ Batch window expiration
4. ✅ Atomic processing
5. ✅ Retry on failure
6. ✅ Metrics tracking
7. ✅ Size limits enforced
8. ✅ Gas savings estimated
9. ✅ All collaborators paid atomically
10. ✅ High-volume stress test (100 batches)

---

## Troubleshooting

### Batch Not Processing

**Check**:
1. Is batch window expired? `windowExpires > current_timestamp`
2. Is contract paused? Call `get_is_paused()`
3. Is balance sufficient? Check token balance

**Fix**: Wait for window to expire or check contract state

### Batch Marked as Failed

**Check**:
1. Retry count reached 3
2. Insufficient token balance
3. Invalid share map

**Fix**: Resolve underlying issue and requeue batch if needed

### Metrics Show Zero Gas Savings

**Check**:
1. No completed batches yet
2. Check `completedBatches` > 0

**Fix**: Wait for batches to complete processing

---

## Best Practices

1. **Queue Regularly**: Queue secondary royalties immediately when they occur
2. **Monitor Window**: Check `windowExpires` timestamp for estimated processing
3. **Track Metrics**: Use metrics endpoint to monitor efficiency gains
4. **Handle Failures**: Implement retry logic for failed batches in client
5. **Verify Atomicity**: Confirm all collaborators received payouts after processing
6. **Archive History**: Periodically export batch history for record-keeping
