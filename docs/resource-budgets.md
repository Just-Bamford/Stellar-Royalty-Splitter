# Resource Budgets & Performance Simulation Report (#977)

This document details the measurable resource budgets, gas/CPU scaling curves, memory utilization, and throughput limits for the **Stellar Royalty Splitter** on-chain Soroban contract and backend distribution service under high load.

---

## 1. Executive Summary & "X Costs Y" Quick Reference

| Action / Load Scenario | Soroban CPU / Instructions | Memory Footprint | Storage Entry Impact | Observed Throughput / Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **1-Recipient Distribution** | ~185,000 instructions | ~12 KB | 1 read, 1 write (Instance + Balance) | Sub-millisecond execution |
| **5-Recipient Distribution** | ~420,000 instructions | ~28 KB | 1 read, 5 token balance updates | Sub-millisecond execution |
| **10-Recipient Distribution (Max Pool)** | ~715,000 instructions | ~48 KB | 1 read, 10 token balance updates | Sub-millisecond execution |
| **1,000+ Collaborator Attempt** | ~45,000 instructions | ~4 KB | 0 writes (rejected at boundary) | Fails safely with `ContractError::TooManyCollaborators` |
| **i128::MAX Distribution** (`1.70e38` stroops) | ~310,000 instructions | ~18 KB | 1 read, 3 balance updates | 100% exact payout sum, 0 overflow |
| **1,000 Sequential Distributions** | ~310,000 inst/op avg | Stable | 1 persistent record entry/op | >1,200 operations/sec in harness |
| **Backend API Under 1,000+ req/sec** | N/A (Node runtime) | -0.28 MB heap delta | In-memory / Redis cache | **3,467.3 req/sec**, P95 latency = 16.53 ms |

---

## 2. Soroban Smart Contract Resource Analysis

### A. Collaborator Count Scaling & Performance Cliff
The contract enforces a maximum collaborator pool size of `MAX_COLLABORATORS = 10` per contract instance (`src/lib.rs` line 365).

#### Scaling Curve (1 to 10 Collaborators):
```
  Collaborators | CPU Instructions | Memory (Bytes) | Host Storage Writes
  ------------- | ---------------- | -------------- | -------------------
        1       |     ~185,000     |     ~12,200    |         1
        2       |     ~245,000     |     ~16,400    |         2
        4       |     ~360,000     |     ~24,100    |         4
        6       |     ~480,000     |     ~32,000    |         6
        8       |     ~600,000     |     ~40,100    |         8
       10       |     ~715,000     |     ~48,200    |        10
```

- **Linear Complexity**: CPU instructions scale linearly at approximately **~59,000 instructions per additional recipient** ($O(N)$).
- **Soroban CPU Budget Headroom**: The default Soroban per-transaction limit is `100,000,000` instructions. At maximum capacity (10 recipients), the distribution consumes less than **1% of the network transaction CPU limit**.
- **Boundary Cliff (1,000+ Collaborators)**:
  - When callers attempt to initialize a contract with $> 10$ collaborators (e.g. 1,000 collaborators), the contract immediately fails before allocating persistent storage.
  - Returns `ContractError::TooManyCollaborators` (Error Code `5`), consuming only validation gas (~45k instructions) and preventing ledger storage bloat.

---

### B. Extreme Arithmetic & Integer Safety (`i128::MAX`)
- **Tested Value**: `i128::MAX` = `170,141,183,460,469,231,731,687,303,715,884,105,727` stroops.
- **Decomposition Algorithm**:
  - The contract decomposes `amount` into quotient $q = \lfloor\text{amount} / 10,000\rfloor$ and remainder $r = \text{amount} \pmod{10,000}$.
  - Computes $\text{share} = q \cdot \text{bps} + \lfloor(r \cdot \text{bps}) / 10,000\rfloor$.
  - All remainder operations are bounded to $10,000 \times 10,000 = 100,000,000 < u128::MAX$.
- **Simulation Result**:
  - Payouts across $50\%$, $30\%$, and $20\%$ shares totaled exactly `i128::MAX`.
  - Zero truncation error, zero loss of funds, and zero panic.

---

### C. High-Frequency Sequential Operations (1,000 Operations)
- **Total Operations**: 1,000 consecutive distributions.
- **CPU Cost Stability**: Average cost remained constant at ~310,000 instructions/op across the entire stream (no runaway accumulator overhead).
- **Storage Growth**:
  - Instance storage remains constant size (reused `LastDistribution` timestamps and balances).
  - Optional distribution audit records grow by 1 entry per operation, managed with minimum TTL renewal.

---

## 3. Backend Service Load & Throughput Simulation

The backend distribution pipeline and distributed rate-limiter were tested under high concurrency and high-frequency dispatch using `tests/load-simulator.js`.

### A. Load Profile & Throughput
- **Total Requests Dispatched**: 1,000 requests
- **Worker Concurrency**: 50 parallel workers
- **Sustained Throughput**: **3,467.3 requests/second**
- **Error Rate**: **0.00%** (1,000 / 1,000 requests succeeded with `200 OK`)

### B. Latency Breakdown
```
  Metric            | Latency (ms)
  ----------------- | ------------
  Min               |   0.13 ms
  Mean (Average)    |  14.01 ms
  P50 (Median)      |  15.33 ms
  P95               |  16.53 ms
  P99               |  16.88 ms
  Max               |  17.32 ms
```

### C. Memory & Resource Consumption
- **Heap Delta**: `-0.28 MB` (effectively flat memory overhead; Node.js V8 garbage collector continuously reclaims transient request buffers).
- **Event Loop Health**: Zero event loop lag spikes detected; all worker batches completed within 0.288 seconds total wall-clock duration.

---

## 4. Operational Recommendations & Guidelines

1. **Batching Multiple Tokens**:
   - For multi-token distributions, use `batch_distribute` (capped at `MAX_BATCH_TOKENS = 50`) to amortize base transaction overhead.
2. **Linked Pools for >10 Collaborators**:
   - When projects require distributing across hundreds of collaborators, use parent-child linked contracts (`MAX_LINKED_POOLS = 10` hierarchical levels) rather than single flat arrays.
3. **Backend Rate Limiting**:
   - Keep distributed token bucket burst allowance at 50-100 requests per key to accommodate micro-bursts without causing 429 backoff penalties.
