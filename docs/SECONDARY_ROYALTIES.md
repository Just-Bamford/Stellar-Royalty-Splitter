# Secondary Royalty Distribution Support

## Overview

**Secondary Royalty Distribution** enables automatic revenue sharing on NFT resales. When an NFT changes hands on secondary markets, royalties are calculated based on a configurable percentage and automatically distributed to all collaborators according to their predefined share allocations.

This feature ensures collaborators continue earning from an NFT's lifecycle beyond the initial sale, building long-term sustainability.

---

## Architecture

### Smart Contract Layer (Rust/Soroban)

The Soroban contract handles:

- **Royalty Rate Management**: Set and retrieve the secondary royalty percentage (in basis points)
- **Secondary Royalty Recording**: Track resale events and accumulate royalties
- **Royalty Distribution**: Split accumulated secondary royalties among collaborators using their primary shares

### Backend API Layer (Node.js/Express)

REST endpoints for:

- Recording secondary sales with automatic royalty calculation
- Setting royalty rates
- Triggering royalty distributions
- Querying royalty statistics and history
- Tracking resale events in an audit trail

### Database Layer (SQLite)

Tables for:

- `secondary_sales`: Records each NFT resale with sale price, royalty amount, and participants
- `secondary_royalty_distributions`: Tracks when royalties are distributed and to whom
- `transactions`: Extended to support secondary royalty transaction types

### Frontend UI (React/TypeScript)

Components for:

- **SecondaryRoyaltyConfig**: Configure secondary royalty rates
- **RecordSecondarySale**: Log NFT resales and calculate royalties
- **DistributeSecondaryRoyalties**: Distribute accumulated royalties to collaborators
- **ResaleHistory**: View secondary sales and distribution history

---

## How It Works

### 1. Configuration

```
Creator sets secondary royalty rate (e.g., 5% = 500 basis points)
```

### 2. Resale Event

```
NFT is sold on secondary market
Marketplace or operator records the sale with price
Contract calculates: royalty = salePrice * royaltyRate / 10000
Royalty accumulates in the contract's secondary royalty pool
```

### 3. Distribution

```
When pool has sufficient royalties, operators trigger distribution
Royalties are split according to primary collaborator shares:
  Artist (60%) → 60% of royalty pool
  Musician (40%) → 40% of royalty pool
Pool is reset after distribution
```

---

## API Reference

### 1. Set Royalty Rate

**Endpoint**: `POST /api/secondary-royalty/set-rate`

**Request**:

```json
{
  "contractId": "C...",
  "walletAddress": "G...",
  "royaltyRate": 500
}
```

**Response**:

```json
{
  "xdr": "AAAAAgAAAABmA...",
  "transactionId": 12
}
```

**Notes**:

- `royaltyRate` is in basis points (1 bp = 0.01%, max 10000 bp = 100%)
- Must be signed with Freighter wallet
- 500 bp = 5% royalty on resales

---

### 2. Record Secondary Sale

**Endpoint**: `POST /api/secondary-royalty`

**Request**:

```json
{
  "contractId": "C...",
  "walletAddress": "G...",
  "nftId": "nft-123",
  "previousOwner": "G...",
  "newOwner": "G...",
  "salePrice": 10000,
  "saleToken": "C...",
  "royaltyRate": 500
}
```

**Response**:

```json
{
  "xdr": "AAAAAgAAAABmA...",
  "transactionId": 13,
  "royaltyAmount": 50,
  "salePriceInput": 10000,
  "royaltyRateInput": 500
}
```

**Notes**:

- Automatically calculates royalty: `salePrice * royaltyRate / 10000`
- Records the sale in audit trail
- Returns royalty amount for verification

---

### 3. Distribute Secondary Royalties

**Endpoint**: `POST /api/secondary-royalty/distribute`

**Request**:

```json
{
  "contractId": "C...",
  "walletAddress": "G...",
  "tokenId": "C..."
}
```

**Response**:

```json
{
  "xdr": "AAAAAgAAAABmA...",
  "transactionId": 14,
  "numberOfSales": 5,
  "totalRoyalties": "250"
}
```

**Notes**:

- Distributes all accumulated secondary royalties
- Uses primary collaborator shares for distribution
- Resets the pool after successful distribution

---

### 4. Get Royalty Statistics

**Endpoint**: `GET /api/secondary-royalty/stats/:contractId`

**Response**:

```json
{
  "totalSecondarySales": 42,
  "totalRoyaltiesGenerated": "2150",
  "lastDistribution": {
    "timestamp": "2024-12-15T10:30:00Z",
    "totalRoyaltiesDistributed": "1050",
    "numberOfSales": 21
  }
}
```

---

### 5. Get Secondary Sales History

**Endpoint**: `GET /api/secondary-royalty/sales/:contractId?limit=50&offset=0&nftId=optional`

**Response**:

```json
{
  "sales": [
    {
      "id": 1,
      "nftId": "nft-123",
      "previousOwner": "G...",
      "newOwner": "G...",
      "salePrice": "10000",
      "saleToken": "C...",
      "royaltyAmount": "500",
      "royaltyRate": 500,
      "timestamp": "2024-12-15T10:00:00Z",
      "transactionHash": "TX..."
    }
  ],
  "total": 1
}
```

---

### 6. Get Distribution History

**Endpoint**: `GET /api/secondary-royalty/distributions/:contractId?limit=50&offset=0`

**Response**:

```json
{
  "distributions": [
    {
      "id": 1,
      "transactionId": 14,
      "totalRoyaltiesDistributed": "1050",
      "numberOfSales": 21,
      "timestamp": "2024-12-15T11:00:00Z",
      "txHash": "TX...",
      "status": "confirmed",
      "initiatorAddress": "G..."
    }
  ]
}
```

---

## Smart Contract Functions

### Rust/Soroban API

```rust
// Set secondary royalty rate (basis points)
pub fn set_royalty_rate(env: Env, rate_bp: u32)

// Get current royalty rate
pub fn get_royalty_rate(env: Env) -> u32

// Record a resale and accumulate royalties
pub fn record_secondary_royalty(env: Env, sale_price: i128) -> i128

// Get and administer the capped secondary royalty pool
pub fn get_secondary_royalty_pool(env: Env) -> i128
pub fn get_max_secondary_pool_size(env: Env) -> i128
pub fn set_max_secondary_pool_size(env: Env, new_limit: i128)

// Distribute accumulated royalties among collaborators
pub fn distribute_secondary_royalties(env: Env, token: Address)
```

The pool defaults to `MAX_SECONDARY_POOL_SIZE` (1 trillion stroops). Deposits
that would exceed the configured limit are rejected. A `pool_warn` event is
emitted when the pool exceeds 80% of its limit. The admin can raise the limit
through `POST /api/secondary-royalty/set-pool-limit`.

---

## Database Schema

### secondary_sales

```sql
CREATE TABLE secondary_sales (
  id INTEGER PRIMARY KEY,
  contractId TEXT NOT NULL,
  nftId TEXT NOT NULL,
  previousOwner TEXT NOT NULL,
  newOwner TEXT NOT NULL,
  salePrice TEXT NOT NULL,
  saleToken TEXT NOT NULL,
  royaltyAmount TEXT NOT NULL,
  royaltyRate INTEGER NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  transactionHash TEXT
);
```

### secondary_royalty_distributions

```sql
CREATE TABLE secondary_royalty_distributions (
  id INTEGER PRIMARY KEY,
  transactionId INTEGER NOT NULL,
  contractId TEXT NOT NULL,
  totalRoyaltiesDistributed TEXT NOT NULL,
  numberOfSales INTEGER NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(transactionId) REFERENCES transactions(id)
);
```

---

## Frontend Components

### SecondaryRoyaltyConfig

Allows setting the secondary royalty percentage for an NFT collection.

```tsx
<SecondaryRoyaltyConfig
  contractId={contractId}
  walletAddress={walletAddress}
  onSuccess={() => refreshData()}
/>
```

### RecordSecondarySale

Logs an NFT resale and calculates royalties automatically.

```tsx
<RecordSecondarySale
  contractId={contractId}
  walletAddress={walletAddress}
  royaltyRate={500}
  onSuccess={() => refreshData()}
/>
```

### DistributeSecondaryRoyalties

Triggers distribution of accumulated royalties to collaborators.

```tsx
<DistributeSecondaryRoyalties
  contractId={contractId}
  walletAddress={walletAddress}
  onSuccess={() => refreshData()}
/>
```

### ResaleHistory

Displays tables of secondary sales and distributions.

```tsx
<ResaleHistory contractId={contractId} />
```

---

## Integration Flow

### Step 1: Deploy Contract

```bash
cargo build --release --target wasm32-unknown-unknown
stellar contract deploy ...
```

### Step 2: Initialize Collaborators

Use `InitializeForm` to set up collaborators and their shares.

### Step 3: Set Royalty Rate

Use `SecondaryRoyaltyConfig` to configure secondary royalty percentage.

### Step 4: Record Resales

When an NFT is sold on secondary market:

1. Marketplace calls `POST /api/secondary-royalty` with sale details
2. Backend calculates royalty and records in database
3. Contract's secondary pool accumulates the royalty

### Step 5: Distribute Royalties

When ready to distribute:

1. Call `POST /api/secondary-royalty/distribute` with token address
2. Contract splits pool among collaborators using primary shares
3. Collaborators receive their proportional royalty payments

---

## Example Workflow

**Setup:**

- 3 collaborators: Artist (60%), Producer (30%), Mixer (10%)
- Secondary royalty rate: 5% (500 bp)

**Resale Events:**

1. NFT #1 sells for 1000 tokens → 50 token royalty
2. NFT #2 sells for 2000 tokens → 100 token royalty
3. NFT #3 sells for 1500 tokens → 75 token royalty
4. **Total pool: 225 tokens**

**Distribution:**

- Artist receives: 225 × 60% = 135 tokens
- Producer receives: 225 × 30% = 67.5 tokens → 67 tokens (rounded)
- Mixer receives: 225 × 10% = 22.5 tokens → 21 tokens (remainder, absorption)
- **Total distributed: 225 tokens**

---

## Best Practices

1. **Set Reasonable Royalty Rates**: Rates too high (>10%) may discourage resales; rates too low (<1%) may not be worth managing.

2. **Regular Distribution Cycles**: Distribute royalties periodically to maintain cash flow for collaborators.

3. **Monitor Statistics**: Use `/api/secondary-royalty/stats` to track royalty generation over time.

4. **Maintain Audit Trail**: All transactions are logged for transparency and dispute resolution.

5. **Verify Calculations**: Always verify computed royalty amounts match expectations before distribution.

---

## Testing

Run integration tests:

```bash
cargo test --test integration_test
```

Tests verify:

- Royalty rate setting and retrieval
- Royalty calculation accuracy
- Pool accumulation across multiple sales
- Correct distribution according to primary shares
- Pool reset after distribution
- Deposits at and above the configured pool limit

---

## Error Handling

| Error                                  | Cause                     | Resolution                  |
| -------------------------------------- | ------------------------- | --------------------------- |
| `no secondary royalties to distribute` | Pool is empty             | Record resales first        |
| `royalty rate exceeds 100%`            | Rate > 10000 bp           | Set rate ≤ 10000 bp         |
| `sale price must be positive`          | Price ≤ 0                 | Provide positive sale price |
| `missing required fields`              | Incomplete request        | Verify all fields present   |
| `contract not initialized`             | Contract setup incomplete | Call initialize first       |

---

## Performance Considerations

- **Database Indexing**: Queries on `contractId`, `nftId`, and `timestamp` are optimized
- **Royalty Calculations**: All math uses integer arithmetic to avoid floating-point precision issues
- **Batch Distribution**: Multiple resales accumulate before distribution for gas efficiency
- **Pagination**: History queries support limit/offset for large datasets

---

## Future Enhancements

- [ ] Tiered royalty rates (different rates for different price ranges)
- [ ] Time-based royalty decay (declining royalties as NFT ages)
- [ ] Beneficiary override (redirect royalties to specific addresses)
- [ ] Royalty splitting between creators and platforms
- [ ] Cross-contract royalty aggregation

---

## Support & Troubleshooting

For issues or questions:

1. Check transaction history in UI for status and errors
2. Verify contract initialization and collaborators setup
3. Ensure royalty rate is set before recording sales
4. Review audit log for detailed transaction records

---

_Last Updated: December 2024_
